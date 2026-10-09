import { COLORS, SOLID } from '../config.js';
import { TAU, clamp01, easeOutBack, glowSprite, hash, rgba } from './fx-util.js';

/** Extra background baked around the canvas so screen shake never uncovers an edge (CSS px). */
export const BG_MARGIN = 24;

const POP = 0.24; // seconds a cell takes to pop in
const SPREAD_PER_STEP = 0.03; // seconds the wave front spends per BFS step …
const MAX_SPREAD = 0.46; // … capped so POP + spread stays under ~700 ms
const FLOOD_SPREAD = 0.85;
const SHINE_LIFE = 0.7;
const BREAK_LIFE = 0.32; // seconds the ice of a shattered region takes to flicker out
const SHINE_ANGLE = 0.6; // radians: the sweep travels top-left → bottom-right
const SHINE_COS = Math.cos(SHINE_ANGLE);
const SHINE_SIN = Math.sin(SHINE_ANGLE);
const SHEEN_PERIODS = [6.3, 9.7]; // seconds per ambient pass
const FLOOD = 0xffff; // pseudo region id of the win flood
const NONE = -1;
const MASK_SCALE = 4; // sheen masks are cols × rows × this: fine enough for a thin glint, still tiny to composite
const SPARKLE_COLORS = ['#ffffff', COLORS.ice[0], COLORS.ice[1], COLORS.ice[3]];
const WAVE_HEAT = '#c9f6ff';

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  return canvas;
}

/**
 * Everything that is baked rather than redrawn: background, captured "ice",
 * the rail, plus the fill waves that feed cells into the ice layer, the
 * sheen / shine passes that glide over it, and the cut-out (and fading ghost)
 * of a region a chipper shattered.
 *
 * Ice and rail live in "board device space": device pixels, origin at the
 * board's top-left, so every cell edge sits on a pixel boundary.
 */
export class BoardLayers {
  constructor(effects, { lowPower = false } = {}) {
    this.effects = effects;
    this.lowPower = lowPower;
    this.grid = null;
    this.view = null;
    this._waves = [];
    this._shines = [];
    this._breaks = [];
    this._bbox = new Map();
    this._facets = new Map();
    this._tints = new Map();
    this._railVersion = -1;
    this._sparkleRamp = effects.particles.ramp(SPARKLE_COLORS);
  }

  /** New level. The caller follows up with layout(), which is what (re)builds the layers. */
  setGrid(grid) {
    this.grid = grid;
    this._pending = new Uint8Array(grid.size);
    this._flood = new Uint8Array(grid.size);
    this._waves.length = 0;
    this._shines.length = 0;
    this._breaks.length = 0;
    this._bbox.clear();
    this._tints.clear();
    this._mask = makeCanvas(grid.cols * MASK_SCALE, grid.rows * MASK_SCALE);
    this._maskCtx = this._mask.getContext('2d');
    this._scratch = makeCanvas(grid.cols * MASK_SCALE, grid.rows * MASK_SCALE);
    this._scratchCtx = this._scratch.getContext('2d');
    const band = this._scratchCtx.createLinearGradient(-1, 0, 1, 0);
    // A broad soft band chased by a thin hard glint: the double reflection that makes glass read as glass.
    band.addColorStop(0, 'rgba(255, 255, 255, 0)');
    band.addColorStop(0.3, 'rgba(255, 255, 255, 0.16)');
    band.addColorStop(0.48, 'rgba(255, 255, 255, 1)');
    band.addColorStop(0.58, 'rgba(255, 255, 255, 0.12)');
    band.addColorStop(0.7, 'rgba(255, 255, 255, 0.04)');
    band.addColorStop(0.74, 'rgba(255, 255, 255, 0.6)');
    band.addColorStop(0.78, 'rgba(255, 255, 255, 0.04)');
    band.addColorStop(1, 'rgba(255, 255, 255, 0)');
    this._bandFill = band;
  }

  /** view = the Renderer (width, height, dpr, cellSize, cellPx, offsetX, offsetY). Re-bakes every layer. */
  layout(view) {
    this.view = view;
    const { grid } = this;
    if (!grid || !view.cellPx) return;
    const cp = view.cellPx;
    const w = grid.cols * cp;
    const h = grid.rows * cp;
    this._ice = makeCanvas(w, h);
    this._iceCtx = this._ice.getContext('2d');
    this._rail = makeCanvas(w, h);
    this._railCtx = this._rail.getContext('2d');

    const base = this._iceCtx.createLinearGradient(0, 0, w, h);
    base.addColorStop(0, '#aeeeff');
    base.addColorStop(0.3, COLORS.ice[1]);
    base.addColorStop(0.68, COLORS.ice[2]);
    base.addColorStop(1, COLORS.ice[3]);
    this._base = base;
    this._facets.clear();

    this._bakeBackground();
    this._bakeIce();
    this._bakeRail();
  }

  // ── Moments ──────────────────────────────────────────────────────────────

  /** Fill wave for a capture result: trail cells pop first, pockets roll out by BFS distance. */
  startCapture(result) {
    const groups = result.maxDist + 1;
    const spread = Math.min(MAX_SPREAD, SPREAD_PER_STEP * result.maxDist);
    const total = result.trailCells.length + result.filled.length;
    const budget = Math.min(520, Math.max(28, total * 0.4)) * (this.lowPower ? 0.5 : 1);
    this._startWave(result.regionId, groups, spread, budget / total, (emit) => {
      for (const c of result.trailCells) emit(c.x, c.y, 0);
      for (const c of result.filled) emit(c.x, c.y, c.d);
    });
  }

  /** Win: every remaining open cell floods outward from `origin`. Visual only — the grid is untouched. */
  startFlood(origin) {
    const { grid } = this;
    const { cols, rows, cells } = grid;
    let far = 0;
    let near = Infinity;
    const dist = (x, y) => Math.round(Math.hypot(x - origin.x, y - origin.y));
    for (let i = 0; i < grid.size; i++) {
      if (cells[i] === SOLID || this._flood[i]) continue;
      const d = dist(i % cols, Math.floor(i / cols));
      if (d > far) far = d;
      if (d < near) near = d;
    }
    if (near === Infinity) return;
    const open = grid.size - grid.capturedCount - 2 * (cols + rows) + 4;
    const budget = (this.lowPower ? 300 : 600) / Math.max(1, open);
    this._startWave(FLOOD, far - near + 1, FLOOD_SPREAD, budget, (emit) => {
      for (let i = 0; i < grid.size; i++) {
        if (cells[i] === SOLID || this._flood[i]) continue;
        const x = i % cols;
        const y = (i - x) / cols;
        emit(x, y, dist(x, y) - near);
      }
    });
    // Marked only once the wave owns them: the emitter above runs twice (count, then place).
    for (let i = 0; i < grid.size; i++) if (cells[i] !== SOLID) this._flood[i] = 1;
  }

  /**
   * A chipper shattered a region (grid.revertRegion result): its cells are open field again. They are cut out
   * of the baked ice and the sheen mask, which is exact: every bake paints a region inside its own cells, and
   * the neighbours already carry their bevel along this border, it being another region's. The region's look
   * is forgotten, and a ghost of its ice flickers out over BREAK_LIFE while it sparkles apart.
   */
  shatter(result) {
    const { regionId, cells } = result;
    this._bbox.delete(regionId);
    this._facets.delete(regionId);
    this._tints.delete(regionId);
    const waves = this._waves;
    for (let w = waves.length - 1; w >= 0; w--) {
      if (waves[w].region !== regionId) continue;
      const { xs, ys } = waves[w];
      for (let k = 0; k < xs.length; k++) this._pending[ys[k] * this.grid.cols + xs[k]] = 0;
      waves.splice(w, 1);
    }
    for (let i = this._shines.length - 1; i >= 0; i--) if (this._shines[i].region === regionId) this._shines.splice(i, 1);
    if (!cells || !cells.length) return;

    const xs = new Uint16Array(cells.length);
    const ys = new Uint16Array(cells.length);
    for (let k = 0; k < cells.length; k++) {
      xs[k] = cells[k].x;
      ys[k] = cells[k].y;
    }
    if (this._ice) {
      eraseCells(this._iceCtx, xs, ys, this.view.cellPx);
      eraseCells(this._maskCtx, xs, ys, MASK_SCALE);
      this._breaks.push({ xs, ys, t: 0 });
    }
    const chance = Math.min(1, (this.lowPower ? 120 : 240) / cells.length);
    const p = this.effects.particles;
    for (let k = 0; k < cells.length; k++) {
      if (Math.random() >= chance) continue;
      const a = Math.random() * TAU;
      const v = 1 + Math.random() * 6;
      const lit = Math.random() < 0.2;
      p.spawn(xs[k] + Math.random() - 0.5, ys[k] + Math.random() - 0.5, Math.cos(a) * v, Math.sin(a) * v, 0.3 + Math.random() * 0.5, lit ? 0.2 : 0.08 + Math.random() * 0.09, 2.5, 0, this._sparkleRamp, lit);
    }
  }

  _startWave(region, groups, spread, sparkleChance, forEachCell) {
    const { cols } = this.grid;
    const starts = new Uint32Array(groups + 1);
    let total = 0;
    forEachCell((x, y, d) => {
      starts[Math.min(groups - 1, d) + 1]++;
      total++;
    });
    if (!total) return;
    for (let g = 0; g < groups; g++) starts[g + 1] += starts[g];

    const xs = new Uint16Array(total);
    const ys = new Uint16Array(total);
    const cursor = starts.slice(0, groups);
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    forEachCell((x, y, d) => {
      const k = cursor[Math.min(groups - 1, d)]++;
      xs[k] = x;
      ys[k] = y;
      this._pending[y * cols + x] = 1;
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
    });
    this._bbox.set(region, box);
    this._facets.delete(region);
    // The wave fills in its own alpha map as it bakes; the shine that follows is masked by it.
    const mask = makeCanvas(this._mask.width, this._mask.height);
    this._waves.push({ region, xs, ys, starts, groups, spread, sparkleChance, mask, maskCtx: mask.getContext('2d'), t: 0, baked: 0, lit: 0 });
  }

  // ── Per-frame ────────────────────────────────────────────────────────────

  update(dt) {
    if (!this.grid || !this._ice) return;
    if (this.grid.version !== this._railVersion) this._bakeRail();

    const waves = this._waves;
    for (let w = waves.length - 1; w >= 0; w--) {
      const wave = waves[w];
      wave.t += dt;
      while (wave.lit < wave.groups && groupStart(wave, wave.lit) <= wave.t) this._sparkle(wave, wave.lit++);
      while (wave.baked < wave.groups && wave.t >= groupStart(wave, wave.baked) + POP) {
        const g = wave.baked++;
        this._bakeCells(wave.xs, wave.ys, wave.starts[g], wave.starts[g + 1], wave.region, true);
        maskCells(wave.maskCtx, wave.xs, wave.ys, wave.starts[g], wave.starts[g + 1]);
      }
      if (wave.baked === wave.groups) {
        waves.splice(w, 1);
        this._startShine(wave);
      }
    }

    const shines = this._shines;
    for (let i = shines.length - 1; i >= 0; i--) {
      shines[i].t += dt;
      if (shines[i].t >= SHINE_LIFE) shines.splice(i, 1);
    }

    const breaks = this._breaks;
    for (let i = breaks.length - 1; i >= 0; i--) {
      breaks[i].t += dt;
      if (breaks[i].t >= BREAK_LIFE) breaks.splice(i, 1);
    }
  }

  drawBackground(ctx, time) {
    const { view } = this;
    const m = BG_MARGIN;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(this._bg, -m, -m, view.width + m * 2, view.height + m * 2);
    if (this.lowPower) return;

    // Two slow blobs of colour keep the empty field from ever looking dead.
    const bw = this.grid.cols * view.cellSize;
    const bh = this.grid.rows * view.cellSize;
    const r = Math.max(bw, bh) * 0.55;
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.offsetX, view.offsetY, bw, bh);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.16;
    let cx = view.offsetX + bw * (0.5 + 0.32 * Math.sin(time * 0.11));
    let cy = view.offsetY + bh * (0.5 + 0.3 * Math.cos(time * 0.083 + 1));
    ctx.drawImage(glowSprite('#1e4fd0', 'soft'), cx - r, cy - r, r * 2, r * 2);
    ctx.globalAlpha = 0.11;
    cx = view.offsetX + bw * (0.5 + 0.34 * Math.cos(time * 0.071 + 2.2));
    cy = view.offsetY + bh * (0.5 + 0.3 * Math.sin(time * 0.097 + 0.6));
    ctx.drawImage(glowSprite('#6a35d8', 'soft'), cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  }

  /** Baked ice, the cells currently popping in, then the sheen and shine passes. */
  drawIce(ctx, time) {
    const { view, grid } = this;
    const bw = grid.cols * view.cellSize;
    const bh = grid.rows * view.cellSize;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(this._ice, view.offsetX, view.offsetY, bw, bh);

    if (this._breaks.length) this._drawBreaks(ctx);
    if (this._waves.length) this._drawWaves(ctx);

    if (!this.lowPower) {
      // Both ambient bands share one masked blit: the upscale onto the board is the costly part.
      const span = grid.cols * SHINE_COS + grid.rows * SHINE_SIN;
      let lo = Infinity;
      let hi = -Infinity;
      this._beginSweep();
      for (let k = 0; k < SHEEN_PERIODS.length; k++) {
        const p = (time / SHEEN_PERIODS[k] + k * 0.37) % 1;
        const half = 5 + k * 4;
        const pos = -half + (span + half * 2) * p;
        this._band(pos, half, k ? 0.1 : 0.16);
        lo = Math.min(lo, pos - half);
        hi = Math.max(hi, pos + half);
      }
      this._endSweep(ctx, this._mask, lo, hi, 0, 0, grid.cols, grid.rows);
    }
    for (const shine of this._shines) {
      const p = shine.t / SHINE_LIFE;
      const eased = p * p * (3 - 2 * p);
      const pos = shine.from - shine.half + (shine.to - shine.from + shine.half * 2) * eased;
      const [x0, y0, x1, y1] = shine.box;
      this._beginSweep();
      this._band(pos, shine.half, 0.62 * Math.sin(Math.PI * p) ** 0.7);
      this._endSweep(ctx, shine.mask, pos - shine.half, pos + shine.half, x0, y0, x1 + 1, y1 + 1);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  drawRail(ctx) {
    const { view, grid } = this;
    ctx.drawImage(this._rail, view.offsetX, view.offsetY, grid.cols * view.cellSize, grid.rows * view.cellSize);
  }

  // ── Waves ────────────────────────────────────────────────────────────────

  _drawWaves(ctx) {
    const { view } = this;
    const cp = view.cellPx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, (view.offsetX + view.shiftX) * view.dpr, (view.offsetY + view.shiftY) * view.dpr);
    for (const wave of this._waves) {
      const { xs, ys, starts } = wave;
      for (let g = wave.baked; g < wave.lit; g++) {
        const p = (wave.t - groupStart(wave, g)) / POP;
        // The ice fills whole cells and fades in once the flash covers them: shrunken cells would leave a
        // grid of dark seams, and faint ice on the dark field reads as grey. The flash carries the pop, and
        // its overshoot melts neighbours into one bright front.
        ctx.beginPath();
        for (let k = starts[g]; k < starts[g + 1]; k++) ctx.rect(xs[k] * cp, ys[k] * cp, cp, cp);
        ctx.globalCompositeOperation = 'source-over';
        this._paint(ctx, wave.region, clamp01((p - 0.15) * 4));
        // Added, never painted: a translucent pale fill over the dark field reads as grey.
        const heat = cp * (0.4 + 0.95 * easeOutBack(Math.min(1, p * 1.6), 1.8));
        const pad = (cp - heat) / 2;
        ctx.beginPath();
        for (let k = starts[g]; k < starts[g + 1]; k++) ctx.rect(xs[k] * cp + pad, ys[k] * cp + pad, heat, heat);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.9 * (1 - p) ** 1.5;
        ctx.fillStyle = WAVE_HEAT;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  /** The ice of a shattered region, already gone from the bake: it blanches, then fades to the open field. */
  _drawBreaks(ctx) {
    const { view } = this;
    const cp = view.cellPx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, (view.offsetX + view.shiftX) * view.dpr, (view.offsetY + view.shiftY) * view.dpr);
    for (const ghost of this._breaks) {
      const p = ghost.t / BREAK_LIFE;
      const { xs, ys } = ghost;
      ctx.beginPath();
      for (let k = 0; k < xs.length; k++) ctx.rect(xs[k] * cp, ys[k] * cp, cp, cp);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = (1 - p) ** 2;
      ctx.fillStyle = this._base;
      ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.7 * (1 - p) ** 3;
      ctx.fillStyle = WAVE_HEAT;
      ctx.fill();
    }
    ctx.restore();
  }

  _sparkle(wave, g) {
    const p = this.effects.particles;
    const { xs, ys, starts } = wave;
    for (let k = starts[g]; k < starts[g + 1]; k++) {
      if (Math.random() >= wave.sparkleChance) continue;
      const a = Math.random() * TAU;
      const v = 1 + Math.random() * 5;
      const lit = Math.random() < 0.18;
      p.spawn(
        xs[k] + Math.random() - 0.5,
        ys[k] + Math.random() - 0.5,
        Math.cos(a) * v,
        Math.sin(a) * v,
        0.25 + Math.random() * 0.5,
        lit ? 0.2 : 0.07 + Math.random() * 0.09,
        2.5,
        0,
        this._sparkleRamp,
        lit,
      );
    }
  }

  _startShine(wave) {
    const [x0, y0, x1, y1] = this._bbox.get(wave.region);
    const from = x0 * SHINE_COS + y0 * SHINE_SIN;
    const to = (x1 + 1) * SHINE_COS + (y1 + 1) * SHINE_SIN;
    // Oldest shine gives way: captures can chain faster than a sweep lasts.
    if (this._shines.length >= 3) this._shines.shift();
    this._shines.push({ region: wave.region, mask: wave.mask, box: [x0, y0, x1, y1], from, to, half: Math.min(9, Math.max(3, (to - from) * 0.16)), t: 0 });
  }

  /**
   * Light sweeps are composed at low resolution on a scratch canvas: clear,
   * add diagonal bands (`pos` / `half` in cells along the sweep direction),
   * then mask to an alpha map of the board and blit it up additively.
   */
  _beginSweep() {
    const s = this._scratchCtx;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-over';
    s.clearRect(0, 0, this._scratch.width, this._scratch.height);
    s.fillStyle = this._bandFill;
  }

  _band(pos, half, alpha) {
    const s = this._scratchCtx;
    const k = MASK_SCALE;
    const far = (this.grid.cols + this.grid.rows) * k;
    s.globalAlpha = alpha;
    s.setTransform(SHINE_COS * half * k, SHINE_SIN * half * k, -SHINE_SIN * far, SHINE_COS * far, SHINE_COS * pos * k, SHINE_SIN * pos * k);
    s.fillRect(-1, -1, 2, 2);
  }

  /**
   * Masks the bands and adds them to the board, blitting only the columns the bands (`lo`..`hi` along the
   * sweep) can reach inside the cell box [x0, x1) × [y0, y1): a full-board upscale per pass is the cost.
   */
  _endSweep(ctx, mask, lo, hi, x0, y0, x1, y1) {
    const { view } = this;
    const s = this._scratchCtx;
    const k = MASK_SCALE;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalAlpha = 1;
    s.globalCompositeOperation = 'destination-in';
    s.drawImage(mask, 0, 0);
    const left = Math.max(x0, Math.floor((lo - SHINE_SIN * y1) / SHINE_COS));
    const right = Math.min(x1, Math.ceil((hi - SHINE_SIN * y0) / SHINE_COS));
    if (right <= left || y1 <= y0) return;
    const cs = view.cellSize;
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this._scratch, left * k, y0 * k, (right - left) * k, (y1 - y0) * k, view.offsetX + left * cs, view.offsetY + y0 * cs, (right - left) * cs, (y1 - y0) * cs);
  }

  // ── Baking ───────────────────────────────────────────────────────────────

  /** What a cell looks like to its neighbours: a region id, FLOOD, or NONE for open field. */
  _regionAt(x, y) {
    const { grid } = this;
    if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) return NONE;
    const i = y * grid.cols + x;
    if (this._flood[i]) return FLOOD;
    return grid.cells[i] === SOLID ? grid.region[i] : NONE;
  }

  /** Fills the current path with the glass look of `region`: board gradient, facet gradient, facet tint. */
  _paint(ctx, region, alpha = 1) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this._base;
    ctx.fill();
    ctx.fillStyle = this._facet(region);
    ctx.fill();
    ctx.fillStyle = this._tint(region);
    ctx.fill();
  }

  /** Light top-left → deep bottom-right across the region's own bounding box, so each capture reads as a facet. */
  _facet(region) {
    let facet = this._facets.get(region);
    if (facet) return facet;
    const cp = this.view.cellPx;
    const [x0, y0, x1, y1] = this._bbox.get(region) || [0, 0, this.grid.cols - 1, this.grid.rows - 1];
    facet = this._iceCtx.createLinearGradient(x0 * cp, y0 * cp, (x1 + 1) * cp, (y1 + 1) * cp);
    facet.addColorStop(0, 'rgba(255, 255, 255, 0.26)');
    facet.addColorStop(0.42, 'rgba(255, 255, 255, 0.02)');
    facet.addColorStop(1, 'rgba(10, 40, 150, 0.42)');
    this._facets.set(region, facet);
    return facet;
  }

  _tint(region) {
    let tint = this._tints.get(region);
    if (tint) return tint;
    if (region === FLOOD) tint = 'rgba(255, 255, 255, 0.26)';
    else if (region === 0) tint = 'rgba(5, 16, 58, 0.5)'; // the outer wall stays a quiet frame
    else {
      const h = hash(region * 7.31 + 0.5);
      tint = h < 0.45 ? `rgba(200, 246, 255, ${(h * 0.3).toFixed(3)})` : `rgba(16, 60, 190, ${((h - 0.45) * 0.5).toFixed(3)})`;
    }
    this._tints.set(region, tint);
    return tint;
  }

  /** Bakes cells [from, to) of one region into the ice layer (and the sheen mask). */
  _bakeCells(xs, ys, from, to, region, release) {
    const ctx = this._iceCtx;
    const cp = this.view.cellPx;
    const { cols } = this.grid;
    ctx.beginPath();
    for (let k = from; k < to; k++) ctx.rect(xs[k] * cp, ys[k] * cp, cp, cp);
    this._paint(ctx, region);

    // Bevel: a crisp line plus a wide soft band, light on the edges facing the light, shade on the far ones.
    const edge = Math.max(1, Math.round(cp * 0.09));
    const band = Math.max(2, Math.round(cp * 0.34));
    this._edgePath(ctx, xs, ys, from, to, region, true, band);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fill();
    this._edgePath(ctx, xs, ys, from, to, region, true, edge);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fill();
    this._edgePath(ctx, xs, ys, from, to, region, false, band);
    ctx.fillStyle = 'rgba(4, 22, 96, 0.13)';
    ctx.fill();
    this._edgePath(ctx, xs, ys, from, to, region, false, edge);
    ctx.fillStyle = 'rgba(3, 14, 60, 0.42)';
    ctx.fill();

    maskCells(this._maskCtx, xs, ys, from, to);
    if (release) for (let k = from; k < to; k++) this._pending[ys[k] * cols + xs[k]] = 0;
  }

  /** Path of the `thick`-pixel strips along every cell edge that borders another region: top / left when `lit`, else bottom / right. */
  _edgePath(ctx, xs, ys, from, to, region, lit, thick) {
    const cp = this.view.cellPx;
    ctx.beginPath();
    for (let k = from; k < to; k++) {
      const x = xs[k];
      const y = ys[k];
      if (lit) {
        if (this._regionAt(x, y - 1) !== region) ctx.rect(x * cp, y * cp, cp, thick);
        if (this._regionAt(x - 1, y) !== region) ctx.rect(x * cp, y * cp, thick, cp);
      } else {
        if (this._regionAt(x, y + 1) !== region) ctx.rect(x * cp, (y + 1) * cp - thick, cp, thick);
        if (this._regionAt(x + 1, y) !== region) ctx.rect((x + 1) * cp - thick, y * cp, thick, cp);
      }
    }
  }

  /** Full rebuild from the grid (new level, resize). Cells still waiting in a wave are left to it. */
  _bakeIce() {
    const { grid } = this;
    const { cols, size } = grid;
    this._iceCtx.clearRect(0, 0, this._ice.width, this._ice.height);
    this._maskCtx.clearRect(0, 0, this._mask.width, this._mask.height);

    let count = 0;
    const order = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      const x = i % cols;
      const y = (i - x) / cols;
      const region = this._regionAt(x, y);
      if (region === NONE) continue;
      let box = this._bbox.get(region);
      if (!box) this._bbox.set(region, (box = [x, y, x, y]));
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
      if (!this._pending[i]) order[count++] = i;
    }
    const regionOf = (i) => (this._flood[i] ? FLOOD : grid.region[i]);
    const sorted = order.subarray(0, count).sort((a, b) => regionOf(a) - regionOf(b) || a - b);
    const xs = new Uint16Array(count);
    const ys = new Uint16Array(count);
    for (let k = 0; k < count; k++) {
      xs[k] = sorted[k] % cols;
      ys[k] = (sorted[k] - xs[k]) / cols;
    }
    for (let from = 0; from < count; ) {
      const region = regionOf(sorted[from]);
      let to = from + 1;
      while (to < count && regionOf(sorted[to]) === region) to++;
      this._bakeCells(xs, ys, from, to, region, false);
      from = to;
    }
  }

  _bakeRail() {
    const { grid, view } = this;
    const ctx = this._railCtx;
    const cp = view.cellPx;
    const segs = grid.railSegments();
    this._railVersion = grid.version;
    ctx.clearRect(0, 0, this._rail.width, this._rail.height);
    ctx.beginPath();
    for (let i = 0; i < segs.length; i += 4) {
      ctx.moveTo((segs[i] + 0.5) * cp, (segs[i + 1] + 0.5) * cp);
      ctx.lineTo((segs[i + 2] + 0.5) * cp, (segs[i + 3] + 0.5) * cp);
    }
    ctx.lineCap = 'round';
    // A dark groove under the line keeps it readable on the brightest ice.
    ctx.strokeStyle = 'rgba(2, 12, 46, 0.5)';
    ctx.lineWidth = cp * 0.58;
    ctx.stroke();
    ctx.strokeStyle = rgba(COLORS.ice[1], 0.3);
    ctx.lineWidth = cp * 0.4;
    ctx.stroke();
    ctx.strokeStyle = COLORS.rail;
    ctx.lineWidth = Math.max(1.5 * view.dpr, cp * 0.13);
    ctx.stroke();
  }

  _bakeBackground() {
    const { view, grid } = this;
    const m = BG_MARGIN;
    const cs = view.cellSize;
    this._bg = makeCanvas(Math.ceil((view.width + m * 2) * view.dpr), Math.ceil((view.height + m * 2) * view.dpr));
    const ctx = this._bg.getContext('2d', { alpha: false });
    ctx.scale(view.dpr, view.dpr);
    ctx.translate(m, m);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(-m, -m, view.width + m * 2, view.height + m * 2);

    const bw = grid.cols * cs;
    const bh = grid.rows * cs;
    const cx = view.offsetX + bw / 2;
    const cy = view.offsetY + bh / 2;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(bw, bh) * 0.75);
    glow.addColorStop(0, COLORS.bgGlow);
    glow.addColorStop(1, rgba(COLORS.bgGlow, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(-m, -m, view.width + m * 2, view.height + m * 2);

    // Dot lattice on the cell corners of the open field.
    const dot = Math.max(1 / view.dpr, cs * 0.085);
    ctx.fillStyle = COLORS.gridDot;
    ctx.beginPath();
    for (let y = 2; y < grid.rows - 1; y++) {
      for (let x = 2; x < grid.cols - 1; x++) {
        ctx.rect(view.offsetX + x * cs - dot / 2, view.offsetY + y * cs - dot / 2, dot, dot);
      }
    }
    ctx.fill();

    const reach = Math.hypot(bw, bh) / 2;
    const vignette = ctx.createRadialGradient(cx, cy, reach * 0.45, cx, cy, reach * 1.05);
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    ctx.fillStyle = vignette;
    ctx.fillRect(-m, -m, view.width + m * 2, view.height + m * 2);
  }
}

function groupStart(wave, g) {
  return wave.groups > 1 ? wave.spread * (g / (wave.groups - 1)) ** 1.1 : 0;
}

/** Clears whole cells out of a board-space layer whose cells are `unit` pixels wide (one path, one fill). */
function eraseCells(ctx, xs, ys, unit) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  for (let i = 0; i < xs.length; i++) ctx.rect(xs[i] * unit, ys[i] * unit, unit, unit);
  ctx.fill();
  ctx.restore();
}

/** Marks cells [from, to) opaque in a low-resolution board alpha map (one rect-only path, one fill). */
function maskCells(ctx, xs, ys, from, to) {
  const k = MASK_SCALE;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  for (let i = from; i < to; i++) ctx.rect(xs[i] * k, ys[i] * k, k, k);
  ctx.fill();
}
