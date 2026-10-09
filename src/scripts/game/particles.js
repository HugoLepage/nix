import { glowSprite, mix } from './fx-util.js';

const STEPS = 12; // colour steps per ramp
const HOT_STEPS = 4; // the youngest steps are near-white and drawn additively; the rest keep their hue
const MAX_RAMPS = 32; // the renderer registers 22 up front: every enemy, power and board effect has its own
const STREAK_TIME = 0.035; // seconds of motion a fast particle smears into a shard
const GLOW_RADIUS = 3.4; // glow sprite radius, in particle sizes (the hot profile is all but clear beyond that)
const MAX_GLOWS = 220; // sprites per frame: each one is a scaled additive blit, the dearest thing drawn here

/**
 * Struct-of-arrays particle pool in BOARD space (cells, cells / second), so a
 * resize never disturbs a running explosion.
 *
 * Dots are bucketed by (ramp, age step) so each bucket sets its style once, then
 * every dot is a plain fillRect. Young, near-white steps are additive so a dense
 * core burns white-hot; older steps are alpha-blended so their hue survives
 * over bright ice, where additive colour would wash out to white. A ramp
 * registered with `additive: false` blends every step (and its shards) normally.
 */
export class Particles {
  constructor(capacity = 16384) {
    this.capacity = capacity;
    this.count = 0;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.invLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.rampOf = new Uint8Array(capacity);
    this.glow = new Uint8Array(capacity);

    this._bucket = new Uint16Array(capacity);
    this._order = new Uint16Array(capacity);
    this._side = new Float32Array(capacity); // per-frame scratch: drawn size in px
    this._counts = new Int32Array(MAX_RAMPS * (STEPS + 1));
    this._cursor = new Int32Array(MAX_RAMPS * (STEPS + 1));
    this._styles = [];
    this._shardStyles = [];
    this._sprites = [];
    this._additive = [];
    this._rampIds = new Map();
    // The same list object comes back on every burst: looked up by identity, it skips building the string key.
    this._byList = new WeakMap();
    this._byFlatList = new WeakMap();
  }

  /**
   * Registers a hot → cool colour list and returns its ramp id (cached per list and blend). Register every
   * list once up front (constructors): ids are handed out in order and past MAX_RAMPS fall back to ramp 0.
   */
  ramp(colors, { additive = true } = {}) {
    const lists = additive ? this._byList : this._byFlatList;
    let id = lists.get(colors);
    if (id !== undefined) return id;
    const key = colors.join('|') + (additive ? '' : '|flat');
    id = this._rampIds.get(key);
    if (id === undefined) id = this._register(key, colors, additive);
    lists.set(colors, id);
    return id;
  }

  _register(key, colors, additive) {
    const id = this._rampIds.size;
    if (id >= MAX_RAMPS) return 0;
    this._rampIds.set(key, id);
    this._additive.push(additive);
    const last = colors.length - 1;
    for (let s = 0; s < STEPS; s++) {
      const t = s / (STEPS - 1);
      const pos = Math.min(1, t / 0.7) * last;
      const k = Math.min(last, Math.floor(pos));
      const alpha = t < 0.5 ? 1 : 1 - ((t - 0.5) / 0.5) ** 1.4;
      this._styles.push(mix(colors[k], colors[Math.min(last, k + 1)], pos - k, alpha));
    }
    this._shardStyles.push(colors[Math.min(1, last)]);
    this._sprites.push(glowSprite(colors[Math.min(1, last)]));
    return id;
  }

  /** Returns false when the pool is full (the particle is simply dropped). */
  spawn(x, y, vx, vy, life, size, drag, gravity, ramp, glow) {
    const i = this.count;
    if (i >= this.capacity || life <= 0) return false;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
    this.invLife[i] = 1 / life;
    this.size[i] = size;
    this.drag[i] = drag;
    this.gravity[i] = gravity;
    this.rampOf[i] = ramp;
    this.glow[i] = glow ? 1 : 0;
    this.count = i + 1;
    return true;
  }

  update(dt) {
    const { x, y, vx, vy, life, drag, gravity } = this;
    let n = this.count;
    let i = 0;
    while (i < n) {
      life[i] -= dt;
      if (life[i] <= 0) {
        n--;
        if (i !== n) this._move(n, i);
        continue;
      }
      const keep = Math.max(0, 1 - drag[i] * dt);
      vx[i] *= keep;
      vy[i] = vy[i] * keep + gravity[i] * dt;
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      i++;
    }
    this.count = n;
  }

  _move(from, to) {
    this.x[to] = this.x[from];
    this.y[to] = this.y[from];
    this.vx[to] = this.vx[from];
    this.vy[to] = this.vy[from];
    this.life[to] = this.life[from];
    this.invLife[to] = this.invLife[from];
    this.size[to] = this.size[from];
    this.drag[to] = this.drag[from];
    this.gravity[to] = this.gravity[from];
    this.rampOf[to] = this.rampOf[from];
    this.glow[to] = this.glow[from];
  }

  /** view = { cellSize, offsetX, offsetY }; ctx is in CSS pixels. */
  draw(ctx, view) {
    const n = this.count;
    if (!n) return;
    const { x, y, vx, vy, life, invLife, size, rampOf, glow } = this;
    const bucket = this._bucket;
    const order = this._order;
    const counts = this._counts;
    const cursor = this._cursor;
    const side = this._side;
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    const ramps = this._rampIds.size;
    const shardFrom = STEPS * ramps;
    const buckets = shardFrom + ramps;
    const smear = STREAK_TIME * cs;

    // Counting sort. Dots go oldest step → youngest so young paint over old and the additive hot
    // steps come last; fast particles go to one shard bucket per ramp at the very end.
    counts.fill(0, 0, buckets);
    for (let i = 0; i < n; i++) {
      const f = life[i] * invLife[i];
      const s = Math.max(1.1, size[i] * cs * (0.45 + 0.55 * f));
      const tx = vx[i] * smear;
      const ty = vy[i] * smear;
      side[i] = s;
      let b;
      if ((tx * tx + ty * ty) * f * f > s * s * 6) b = shardFrom + rampOf[i];
      else b = (STEPS - 1 - Math.min(STEPS - 1, ((1 - f) * STEPS) | 0)) * ramps + rampOf[i];
      bucket[i] = b;
      counts[b]++;
    }
    let sum = 0;
    for (let b = 0; b < buckets; b++) {
      cursor[b] = sum;
      sum += counts[b];
    }
    for (let i = 0; i < n; i++) order[cursor[bucket[i]]++] = i;

    // Dots: one fillRect each. A single path of hundreds of rect() subpaths is cheap in software, but on a
    // GPU canvas it costs in proportion to the area the burst covers, which stalls hi-DPI screens.
    const hotFrom = (STEPS - HOT_STEPS) * ramps;
    const additive = this._additive;
    ctx.globalAlpha = 1;
    let blend = '';
    let start = 0;
    for (let b = 0; b < shardFrom; b++) {
      const end = start + counts[b];
      if (end === start) continue;
      const mode = b >= hotFrom && additive[b % ramps] ? 'lighter' : 'source-over';
      if (mode !== blend) ctx.globalCompositeOperation = blend = mode;
      ctx.fillStyle = this._styles[(b % ramps) * STEPS + STEPS - 1 - Math.floor(b / ramps)];
      for (let k = start; k < end; k++) {
        const i = order[k];
        const s = side[i];
        ctx.fillRect(ox + x[i] * cs - s * 0.5, oy + y[i] * cs - s * 0.5, s, s);
      }
      start = end;
    }

    // Shards: streaks pointing back along the velocity, shrinking to nothing as they die. Stroked, not
    // filled (sliver triangles are an order of magnitude slower), and one path each, as with the dots.
    ctx.lineCap = 'butt';
    const wide = Math.max(2.2, cs * 0.17);
    const thin = Math.max(1, cs * 0.07);
    for (let r = 0; r < ramps; r++) {
      const end = start + counts[shardFrom + r];
      if (end === start) continue;
      ctx.globalCompositeOperation = additive[r] ? 'lighter' : 'source-over';
      ctx.strokeStyle = this._shardStyles[r];
      for (let pass = 0; pass < 2; pass++) {
        ctx.globalAlpha = pass ? 1 : 0.24;
        ctx.lineWidth = pass ? thin : wide;
        for (let k = start; k < end; k++) {
          const i = order[k];
          const reach = smear * life[i] * invLife[i];
          const px = ox + x[i] * cs;
          const py = oy + y[i] * cs;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px - vx[i] * reach, py - vy[i] * reach);
          ctx.stroke();
        }
      }
      start = end;
    }

    ctx.globalCompositeOperation = 'lighter';
    let glows = 0;
    for (let i = 0; i < n && glows < MAX_GLOWS; i++) {
      if (!glow[i]) continue;
      const f = life[i] * invLife[i];
      const alpha = f * f * 0.55;
      if (alpha < 0.03) continue;
      glows++;
      const r = size[i] * cs * GLOW_RADIUS;
      ctx.globalAlpha = alpha;
      ctx.drawImage(this._sprites[rampOf[i]], ox + x[i] * cs - r, oy + y[i] * cs - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  clear() {
    this.count = 0;
  }
}
