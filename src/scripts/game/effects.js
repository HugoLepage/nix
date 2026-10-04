import { COLORS } from '../config.js';
import { Particles } from './particles.js';
import { TAU, clamp01, easeOutBack, easeOutCubic, glowSprite } from './fx-util.js';

const SHAKE_DECAY = 6.5; // 1 / seconds
const MAX_SHAKE = 1.4; // cells
const POPUP_LIFE = 1.15;
const SCORCH_COLOR = '#01040c';
const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * Transient screen effects. Every coordinate, radius, speed and size is in
 * BOARD space (cells); draw() maps to pixels through the view it is handed.
 * update() takes REAL frame time: effects keep flowing during a hit-stop.
 */
export class Effects {
  constructor({ lowPower = false, reducedMotion = false } = {}) {
    this.lowPower = lowPower;
    this.particles = new Particles(lowPower ? 8192 : 16384);
    this.shakeX = 0; // cells
    this.shakeY = 0;
    this._countScale = lowPower ? 0.5 : 1;
    this._motionScale = reducedMotion ? 0.3 : 1;
    this._shake = 0;
    this._clock = 0;
    this._stop = 0;
    this._rings = [];
    this._scorches = [];
    this._flares = [];
    this._popups = [];
    this._tasks = [];
    this._flash = { color: '#fff', alpha: 0, life: 1, t: 1, origin: null };
  }

  /** 0 while a hit-stop is running, else 1. The game multiplies its simulation dt by this. */
  get timeScale() {
    return this._stop > 0 ? 0 : 1;
  }

  /**
   * Radial burst with a deliberately wide speed spread: a dense cloud of slow
   * embers, a mid bloom, and a few fast shards. `speed` is the shard speed.
   * `angle` / `spread` aim it (fountains), `gravity` pulls it down. `additive: false` blends the
   * hot dots and the shards normally, so a warm hue keeps its colour over bright ice.
   */
  explode(x, y, {
    colors = COLORS.playerBurst,
    count = 600,
    speed = 22,
    life = 1.2,
    size = 0.15,
    drag = 1,
    gravity = 0,
    angle = 0,
    spread = TAU,
    glow = 0.05,
    additive = true,
  } = {}) {
    const p = this.particles;
    const ramp = p.ramp(colors, { additive });
    const n = Math.round(count * this._countScale);
    for (let i = 0; i < n; i++) {
      const kind = Math.random();
      const r = Math.random();
      let v;
      let d;
      let l;
      let s;
      if (kind < 0.45) {
        v = speed * 0.32 * r * r;
        d = 0.8 + Math.random() * 0.9;
        l = life * (0.6 + Math.random() * 0.7);
        s = size * (0.6 + Math.random() * 0.7);
      } else if (kind < 0.85) {
        v = speed * (0.25 + 0.6 * r);
        d = 1.5 + Math.random() * 1.2;
        l = life * (0.4 + Math.random() * 0.5);
        s = size * (0.5 + Math.random() * 0.6);
      } else {
        v = speed * (0.9 + 1.1 * r);
        d = 2.2 + Math.random() * 1.6;
        l = life * (0.25 + Math.random() * 0.3);
        s = size * (0.4 + Math.random() * 0.4);
      }
      const a = angle + (Math.random() - 0.5) * spread;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const jitter = Math.random() * 0.35;
      const lit = Math.random() < glow;
      if (!p.spawn(x + cos * jitter, y + sin * jitter, cos * v, sin * v, l, lit ? s * 1.5 : s, d * drag, gravity, ramp, lit)) {
        return;
      }
    }
  }

  /** Small omnidirectional spray. */
  sparks(x, y, { colors = COLORS.playerBurst, count = 16, speed = 7, life = 0.5, size = 0.11 } = {}) {
    this.explode(x, y, { colors, count, speed, life, size, glow: 0.12 });
  }

  /** Expanding ring. `delay` lets several rings be queued in one call site. */
  shockwave(x, y, { color = COLORS.ice[1], radius = 8, life = 0.6, width = 0.5, delay = 0 } = {}) {
    this._rings.push({ x, y, color, radius, life, width, t: -delay });
  }

  /** Soft additive bloom that swells and fades: the hot core of a burst. */
  flare(x, y, { color = '#ffffff', radius = 4, life = 0.3 } = {}) {
    this._flares.push({ x, y, sprite: glowSprite(color), radius, life, t: 0 });
  }

  /**
   * Momentary dark bruise under a blast. Additive particles wash out to white over bright ice;
   * this gives them something dark to glow against, then heals away. Drawn by drawUnder(), so it
   * sits under the actors and the particles and never dims a sprite.
   */
  scorch(x, y, { radius = 10, life = 1.4, alpha = 0.8 } = {}) {
    this._scorches.push({ x, y, radius, life, alpha, t: 0 });
  }

  /**
   * Brief light-up of the screen. With an `origin` ({ x, y, radius? } in cells) it blooms out from there;
   * without one it is a uniform veil, which over the dark field reads as grey haze, so keep that one faint.
   */
  flash(color = '#ffffff', alpha = 0.35, life = 0.3, origin = null) {
    const f = this._flash;
    f.color = color;
    f.origin = origin ? { x: origin.x, y: origin.y, radius: origin.radius || 0 } : null;
    f.alpha = alpha * (this._motionScale < 1 ? 0.5 : 1);
    f.life = life;
    f.t = 0;
  }

  /** Adds screen shake (cells). Never stacks past the strongest request. */
  shake(amount) {
    this._shake = Math.min(MAX_SHAKE, Math.max(this._shake, amount * this._motionScale));
  }

  /** Floating text rising from a board position. */
  popup(x, y, text) {
    this._popups.push({ x, y, text, t: 0 });
  }

  hitStop(seconds) {
    this._stop = Math.max(this._stop, seconds);
  }

  /** Runs `fn` after `delay` seconds of effect time (dropped by clear()). */
  schedule(delay, fn) {
    this._tasks.push({ t: delay, fn });
  }

  update(dt) {
    this._clock += dt;
    this._stop = Math.max(0, this._stop - dt);

    const tasks = this._tasks;
    for (let i = tasks.length - 1; i >= 0; i--) {
      tasks[i].t -= dt;
      if (tasks[i].t > 0) continue;
      const { fn } = tasks[i];
      tasks.splice(i, 1);
      fn();
    }

    this.particles.update(dt);
    advance(this._rings, dt);
    advance(this._scorches, dt);
    advance(this._flares, dt);
    const popups = this._popups;
    for (let i = popups.length - 1; i >= 0; i--) {
      popups[i].t += dt;
      if (popups[i].t >= POPUP_LIFE) popups.splice(i, 1);
    }
    if (this._flash.t < this._flash.life) this._flash.t += dt;

    this._shake *= Math.exp(-SHAKE_DECAY * dt);
    if (this._shake < 0.004) this._shake = 0;
    const c = this._clock;
    this.shakeX = this._shake * (Math.sin(c * 73.1) + Math.sin(c * 41.7 + 1.3)) * 0.5;
    this.shakeY = this._shake * (Math.sin(c * 67.3 + 2.1) + Math.sin(c * 37.9 + 0.4)) * 0.5;
  }

  /** The board-level pass (scorches), drawn under the actors. Same view and ctx as draw(). */
  drawUnder(ctx, view) {
    if (!this._scorches.length) return;
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    ctx.globalCompositeOperation = 'source-over';
    for (const s of this._scorches) {
      const p = s.t / s.life;
      const r = s.radius * cs * (0.6 + 0.4 * easeOutCubic(Math.min(1, p * 4)));
      ctx.globalAlpha = s.alpha * Math.min(1, p * 12) * (1 - p) ** 1.5;
      ctx.drawImage(glowSprite(SCORCH_COLOR, 'flat'), ox + s.x * cs - r, oy + s.y * cs - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  /** view = { cellSize, offsetX, offsetY, width, height }; ctx in CSS pixels (shake already applied). */
  draw(ctx, view) {
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;

    ctx.globalCompositeOperation = 'lighter';
    for (const f of this._flares) {
      const p = f.t / f.life;
      const r = f.radius * cs * (0.35 + 0.65 * easeOutCubic(p));
      ctx.globalAlpha = (1 - p) * (1 - p);
      ctx.drawImage(f.sprite, ox + f.x * cs - r, oy + f.y * cs - r, r * 2, r * 2);
    }

    ctx.lineCap = 'butt';
    for (const ring of this._rings) {
      if (ring.t < 0) continue;
      const p = ring.t / ring.life;
      const r = ring.radius * cs * easeOutCubic(p);
      const fade = (1 - p) ** 1.6;
      ctx.strokeStyle = ring.color;
      ctx.beginPath();
      ctx.arc(ox + ring.x * cs, oy + ring.y * cs, r, 0, TAU);
      ctx.globalAlpha = fade * 0.3;
      ctx.lineWidth = cs * (ring.width * 2.4 * (1 - p) + 0.2);
      ctx.stroke();
      ctx.globalAlpha = fade;
      ctx.lineWidth = cs * (ring.width * 0.5 * (1 - p) + 0.07);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    this.particles.draw(ctx, view);

    if (this._popups.length) this._drawPopups(ctx, cs, ox, oy);

    const flash = this._flash;
    if (flash.t < flash.life && flash.alpha > 0) {
      ctx.globalAlpha = flash.alpha * (1 - flash.t / flash.life) ** 1.5;
      if (flash.origin) {
        const r = flash.origin.radius * cs || Math.hypot(view.width, view.height) * 0.75;
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(glowSprite(flash.color, 'bloom'), ox + flash.origin.x * cs - r, oy + flash.origin.y * cs - r, r * 2, r * 2);
      } else {
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = flash.color;
        // Oversized so the shake translation never uncovers an edge.
        ctx.fillRect(-64, -64, view.width + 128, view.height + 128);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawPopups(ctx, cs, ox, oy) {
    const px = Math.max(15, cs * 1.55);
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = `600 ${px}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, px * 0.22);
    ctx.strokeStyle = 'rgba(3, 12, 40, 0.7)';
    ctx.fillStyle = '#f4fdff';
    for (const pop of this._popups) {
      const p = pop.t / POPUP_LIFE;
      const scale = 0.4 + 0.6 * easeOutBack(clamp01(pop.t / 0.22), 2.4);
      const x = ox + pop.x * cs;
      const y = oy + (pop.y - 2.6 * easeOutCubic(p)) * cs;
      ctx.globalAlpha = clamp01((1 - p) / 0.35);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.strokeText(pop.text, 0, 0);
      ctx.fillText(pop.text, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /** Drops every running effect (level change). */
  clear() {
    this.particles.clear();
    this._rings.length = 0;
    this._scorches.length = 0;
    this._flares.length = 0;
    this._popups.length = 0;
    this._tasks.length = 0;
    this._flash.t = this._flash.life;
    this._shake = 0;
    this._stop = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }
}

function advance(list, dt) {
  for (let i = list.length - 1; i >= 0; i--) {
    list[i].t += dt;
    if (list[i].t >= list[i].life) list.splice(i, 1);
  }
}
