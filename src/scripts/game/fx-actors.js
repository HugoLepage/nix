import { COLORS } from '../config.js';
import { TAU, clamp01, easeOutBack, easeOutCubic, glowSprite, hash, mix } from './fx-util.js';

const COMET_SAMPLES = 96; // one per frame: covers COMET_LIFE up to ~265 Hz
const COMET_LIFE = 0.36; // seconds a ribbon sample stays visible
const COMET_WIDTHS = [0.5, 0.38, 0.26, 0.14]; // cells, newest band → oldest
const COMET_ALPHAS = [0.5, 0.32, 0.18, 0.08];
const SPAWN_LIFE = 0.55;
const SPAWN_POP = 0.3; // moment the rings close and the sparks fly
const IMPACT_LIFE = 0.12; // white freeze-frame of the dying player
const GHOST_LIFE = 0.3; // after-image of a cleared trail
const QIX_SEGMENTS = 14;
const QIX_STEP = 0.05; // seconds of qix phase between ribbon samples
// Ribbon endpoints stay within this × radius: under radius + 0.5 for the 1.3-cell qix, so the drawn line never
// crosses a trail's centre line unless the hit circle touches that trail too.
const QIX_REACH = 1.35;
const QIX_HALO = 1.8; // glow radius, × radius: wider than the ribbon, so the qix still reads big
const ARM_MARGIN = 0.35; // cells a ribbon arm stays clear of land: the arrowhead pokes ~0.3 cell past its rail cell
const EMBER_SPACING = 0.3; // cells travelled per sparx ember
const DRAW_SPARK_SPACING = 0.4; // cells travelled per trail-head spark
const TRAIL_COLORS = ['#ffffff', COLORS.trail, COLORS.ice[2], COLORS.ice[3]];
const NO_DASH = [];
const RIM = 'rgba(2, 12, 44, 0.55)'; // dark edge that lifts the arrow off bright ice
const LIVE = new Float32Array(4); // scratch for the qix line at its current phase

const QIX_STYLES = Array.from({ length: QIX_SEGMENTS }, (_, k) => {
  const fresh = (k + 1) / QIX_SEGMENTS;
  return mix('#8b5cf6', COLORS.qix, fresh, 0.2 + 0.8 * fresh ** 1.2);
});

/**
 * Draws the trail and the entities, and owns every bit of visual state they
 * need (comet ribbon, qix line history, ember spacing, spawn / death timers)
 * keyed off the logic objects, which stay animation-free.
 */
export class Actors {
  constructor(effects, { lowPower = false } = {}) {
    this.effects = effects;
    this.lowPower = lowPower;
    this._trailRamp = effects.particles.ramp(TRAIL_COLORS);
    this._emberRamp = effects.particles.ramp(COLORS.sparxBurst);
    this._qixRamp = effects.particles.ramp(COLORS.qixBurst);
    // x, y, time. Float64: a float32 time can round above the clock, and a negative age re-strokes the head.
    this._comet = new Float64Array(COMET_SAMPLES * 3);
    this._dash = [0, 0];
    this._playerFill = null;
    this.reset();
  }

  /** New level: forget every tracked entity. */
  reset() {
    this._time = 0;
    this._cometHead = 0;
    this._cometCount = 0;
    this._sparkOdometer = 0;
    this._last = { x: 0, y: 0, angle: Math.PI / 2, known: false };
    this._trailStart = { x: 0, y: 0, known: false };
    this._spawn = { t: SPAWN_LIFE, popped: true };
    this._impact = { x: 0, y: 0, angle: 0, t: IMPACT_LIFE };
    this._ghost = { points: null, t: GHOST_LIFE };
    this._sparx = new Map();
    this._qix = new Map();
  }

  /** Where the player was last seen alive (board centre before any frame has been drawn). */
  lastPlayerPosition(grid) {
    const { x, y, known } = this._last;
    return known ? { x, y } : { x: (grid.cols - 1) / 2, y: (grid.rows - 1) / 2 };
  }

  // ── Moments ──────────────────────────────────────────────────────────────

  playerSpawned(player) {
    this._spawn.t = 0;
    this._spawn.popped = false;
    this._cometCount = 0;
    this._last.x = player.x;
    this._last.y = player.y;
    this._last.known = true;
  }

  playerDied(x, y) {
    const impact = this._impact;
    impact.x = x;
    impact.y = y;
    impact.angle = this._last.angle;
    impact.t = 0;
    this._cometCount = 0;
  }

  /** The dropped trail lingers as a fading after-image while sparks peel off along its length. */
  trailCleared(cells) {
    if (!cells.length) return;
    const start = this._trailStart;
    const lead = start.known && Math.abs(start.x - cells[0].x) + Math.abs(start.y - cells[0].y) === 1 ? 1 : 0;
    const points = new Float32Array((cells.length + lead) * 2);
    if (lead) {
      points[0] = start.x;
      points[1] = start.y;
    }
    const perCell = (cells.length > 220 ? 2 : 3) * (this.lowPower ? 0.5 : 1);
    const p = this.effects.particles;
    for (let k = 0; k < cells.length; k++) {
      const { x, y } = cells[k];
      points[(k + lead) * 2] = x;
      points[(k + lead) * 2 + 1] = y;
      const n = Math.floor(perCell + Math.random());
      for (let j = 0; j < n; j++) {
        const a = Math.random() * TAU;
        const v = 0.5 + Math.random() * Math.random() * 9;
        p.spawn(
          x + Math.random() - 0.5,
          y + Math.random() - 0.5,
          Math.cos(a) * v,
          Math.sin(a) * v,
          0.35 + Math.random() * 0.7,
          0.07 + Math.random() * 0.1,
          2.2,
          0,
          this._trailRamp,
          false,
        );
      }
    }
    this._ghost.points = points;
    this._ghost.t = 0;
    start.known = false;
  }

  /** Shatters the ribbon of the qix that died at (x, y) into shards along its last lines. */
  qixShattered(x, y) {
    for (const [qix, state] of this._qix) {
      if (Math.hypot(state.x - x, state.y - y) > 3) continue;
      const p = this.effects.particles;
      const perLine = this.lowPower ? 8 : 16;
      for (let s = 0; s < state.count; s++) {
        const o = s * 4;
        for (let j = 0; j < perLine; j++) {
          const f = Math.random();
          const sx = state.lines[o] + (state.lines[o + 2] - state.lines[o]) * f;
          const sy = state.lines[o + 1] + (state.lines[o + 3] - state.lines[o + 1]) * f;
          const a = Math.atan2(sy - y, sx - x) + (Math.random() - 0.5) * 0.8;
          const v = 2 + Math.random() * 12;
          p.spawn(sx, sy, Math.cos(a) * v, Math.sin(a) * v, 0.5 + Math.random() * 0.9, 0.1 + Math.random() * 0.1, 2.4, 0, this._qixRamp, false);
        }
      }
      this._qix.delete(qix);
      return;
    }
  }

  // ── Per-frame ────────────────────────────────────────────────────────────

  update(scene, dt) {
    this._time += dt;
    this._spawn.t += dt;
    this._impact.t += dt;
    this._ghost.t += dt;
    if (this._ghost.t >= GHOST_LIFE) this._ghost.points = null;

    const { grid, player } = scene;
    if (grid.trailStart) {
      this._trailStart.x = grid.trailStart.x;
      this._trailStart.y = grid.trailStart.y;
      this._trailStart.known = true;
    }
    if (player && player.alive) this._trackPlayer(player);
    for (const sparx of scene.sparx) if (sparx.alive !== false) this._trackSparx(sparx);
    for (const qix of scene.qixes) if (qix.alive !== false) this._trackQix(qix, grid);

    const spawn = this._spawn;
    if (!spawn.popped && spawn.t >= SPAWN_POP) {
      spawn.popped = true;
      this.effects.sparks(this._last.x, this._last.y, { colors: COLORS.playerBurst, count: 46, speed: 9, life: 0.55 });
      this.effects.flare(this._last.x, this._last.y, { color: COLORS.ice[0], radius: 3.2, life: 0.35 });
    }
  }

  _trackPlayer(player) {
    const last = this._last;
    const step = last.known ? Math.hypot(player.x - last.x, player.y - last.y) : 0;
    // A jump of several cells is a respawn, not motion: never draw a ribbon across the board.
    if (step > 3) this._cometCount = 0;
    if (step > 0.02 || !last.known) {
      const o = this._cometHead * 3;
      this._comet[o] = player.x;
      this._comet[o + 1] = player.y;
      this._comet[o + 2] = this._time;
      this._cometHead = (this._cometHead + 1) % COMET_SAMPLES;
      this._cometCount = Math.min(COMET_SAMPLES, this._cometCount + 1);

      if (player.drawing && step <= 3) {
        this._sparkOdometer += step;
        while (this._sparkOdometer >= DRAW_SPARK_SPACING) {
          this._sparkOdometer -= DRAW_SPARK_SPACING;
          const a = player.angle + Math.PI + (Math.random() - 0.5) * 2.2;
          const v = 1.5 + Math.random() * 5;
          // Born at the notch, so they stream out from behind the arrow rather than across it.
          const bx = player.x - Math.cos(player.angle) * 0.35;
          const by = player.y - Math.sin(player.angle) * 0.35;
          this.effects.particles.spawn(bx, by, Math.cos(a) * v, Math.sin(a) * v, 0.2 + Math.random() * 0.35, 0.06 + Math.random() * 0.07, 3, 0, this._trailRamp, false);
        }
      }
      last.x = player.x;
      last.y = player.y;
      last.known = true;
    }
    last.angle = player.angle;
  }

  _trackSparx(sparx) {
    let state = this._sparx.get(sparx);
    if (!state) this._sparx.set(sparx, (state = { x: sparx.x, y: sparx.y, odometer: 0 }));
    const step = Math.hypot(sparx.x - state.x, sparx.y - state.y);
    state.x = sparx.x;
    state.y = sparx.y;
    if (step > 3) return;
    state.odometer += step;
    while (state.odometer >= EMBER_SPACING) {
      state.odometer -= EMBER_SPACING;
      const a = Math.random() * TAU;
      const v = Math.random() * 1.6;
      this.effects.particles.spawn(sparx.x, sparx.y, Math.cos(a) * v, Math.sin(a) * v, 0.25 + Math.random() * 0.4, 0.09 + Math.random() * 0.08, 2, 0, this._emberRamp, false);
    }
  }

  _trackQix(qix, grid) {
    let state = this._qix.get(qix);
    if (!state) {
      state = { lines: new Float32Array(QIX_SEGMENTS * 4), head: 0, count: 0, sampled: qix.phase, seed: this._qix.size * 2.39, x: qix.x, y: qix.y };
      this._qix.set(qix, state);
    }
    state.x = qix.x;
    state.y = qix.y;
    // Keyed to the qix's own clock: a paused game freezes the ribbon too.
    if (qix.phase - state.sampled > QIX_STEP * QIX_SEGMENTS) state.sampled = qix.phase - QIX_STEP * QIX_SEGMENTS;
    while (qix.phase - state.sampled >= QIX_STEP) {
      state.sampled += QIX_STEP;
      qixEnds(qix, grid, state.sampled, state.seed, state.lines, state.head * 4);
      state.head = (state.head + 1) % QIX_SEGMENTS;
      state.count = Math.min(QIX_SEGMENTS, state.count + 1);
    }
  }

  /** view = the Renderer; ctx is in CSS pixels with the shake already applied. */
  draw(ctx, view, scene) {
    const { grid, player } = scene;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (this._ghost.points) this._drawGhost(ctx, view);
    if (grid.trail.length) this._drawTrail(ctx, view, grid, player);
    for (const qix of scene.qixes) if (qix.alive !== false) this._drawQix(ctx, view, qix, grid);
    for (const sparx of scene.sparx) if (sparx.alive !== false) this._drawSparx(ctx, view, sparx);
    if (player && player.alive) this._drawPlayer(ctx, view, player, grid);
    else if (this._impact.t < IMPACT_LIFE) this._drawImpact(ctx, view);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Trail ────────────────────────────────────────────────────────────────

  _drawTrail(ctx, view, grid, player) {
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    const { trail, trailStart } = grid;
    // The newest trail cell is the one being entered: the line must stop at the arrow, not run ahead of it.
    const live = player && player.alive && player.drawing;
    const n = live ? trail.length - 1 : trail.length;
    const sx = ox + (trailStart ? trailStart.x : trail[0].x) * cs;
    const sy = oy + (trailStart ? trailStart.y : trail[0].y) * cs;

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    for (let k = 0; k < n; k++) ctx.lineTo(ox + trail[k].x * cs, oy + trail[k].y * cs);
    if (live) ctx.lineTo(ox + player.x * cs, oy + player.y * cs);

    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = COLORS.ice[2];
    ctx.globalAlpha = 0.16;
    ctx.lineWidth = cs * 1.25;
    ctx.stroke();
    ctx.strokeStyle = COLORS.trail;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = cs * 0.62;
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(2, cs * 0.26);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, cs * 0.1);
    ctx.stroke();

    // Energy pulses streaming from the origin toward the arrow.
    this._dash[0] = cs * 0.55;
    this._dash[1] = cs * 2.6;
    ctx.setLineDash(this._dash);
    ctx.lineDashOffset = -this._time * cs * 17;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = Math.max(2, cs * 0.3);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);

    const pulse = 0.5 + 0.5 * Math.sin(this._time * 7);
    const r = cs * (1.5 + 0.35 * pulse);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(glowSprite(COLORS.trail), sx - r, sy - r, r * 2, r * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(sx, sy, cs * (0.26 + 0.05 * pulse), 0, TAU);
    ctx.fill();
  }

  _drawGhost(ctx, view) {
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    const { points, t } = this._ghost;
    const p = t / GHOST_LIFE;
    ctx.beginPath();
    ctx.moveTo(ox + points[0] * cs, oy + points[1] * cs);
    for (let k = 2; k < points.length; k += 2) ctx.lineTo(ox + points[k] * cs, oy + points[k + 1] * cs);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = COLORS.trail;
    ctx.globalAlpha = 0.4 * (1 - p);
    ctx.lineWidth = cs * (0.5 + 1.6 * p);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = (1 - p) ** 2;
    ctx.lineWidth = Math.max(1, cs * 0.16 * (1 - p));
    ctx.stroke();
  }

  // ── Player ───────────────────────────────────────────────────────────────

  _drawPlayer(ctx, view, player, grid) {
    const cs = view.cellSize;
    const px = view.offsetX + (player.x + 0.5) * cs;
    const py = view.offsetY + (player.y + 0.5) * cs;
    const time = this._time;
    const spawn = this._spawn;

    if (this._cometCount) this._drawComet(ctx, view, px, py);

    let scale = player.moving ? 1 : 1 + 0.06 * Math.sin(time * 3.2);
    if (spawn.t < SPAWN_LIFE) {
      this._drawSpawnRings(ctx, cs, px, py, spawn.t / SPAWN_LIFE);
      scale *= easeOutBack(clamp01((spawn.t - 0.12) / 0.34), 2.6);
    }
    const blink = player.invuln > 0 && Math.sin(time * 18) < 0;

    ctx.globalCompositeOperation = 'lighter';
    const halo = cs * (player.drawing ? 2.7 : 2.2) * (player.moving ? 1 : 1 + 0.12 * Math.sin(time * 3.2)) * Math.min(1, scale);
    ctx.globalAlpha = blink ? 0.3 : player.drawing ? 0.8 : 0.6;
    ctx.drawImage(glowSprite(COLORS.ice[1]), px - halo, py - halo, halo * 2, halo * 2);

    if (player.invuln > 0) {
      const r = cs * (1.25 + 0.08 * Math.sin(time * 9));
      ctx.globalAlpha = Math.min(1, player.invuln * 2.5) * (blink ? 0.25 : 0.9);
      ctx.strokeStyle = COLORS.ice[0];
      ctx.lineWidth = Math.max(1.5, cs * 0.11);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha *= 0.3;
      ctx.lineWidth = cs * 0.4;
      ctx.stroke();
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = blink ? 0.5 : 1;
    if (scale > 0.01) {
      // A dark rim lifts the arrow off bright ice, but it must not cut the line off from the notch it
      // runs into: the newest stretch of line is laid again between the rim and the body.
      this._drawArrow(ctx, px, py, player.angle, cs * scale, RIM, 0.52);
      if (player.drawing) this._drawTrailTip(ctx, view, grid, player);
      this._drawArrow(ctx, px, py, player.angle, cs * scale, null);
    }
  }

  /**
   * The arrowhead, its corners rounded by a fat round-joined stroke. `tint` overrides the white → ice
   * gradient (impact frame, rim); `edge` is the stroke width in cells.
   */
  _drawArrow(ctx, px, py, angle, unit, tint, edge = 0.2) {
    if (!this._playerFill) {
      const fill = ctx.createLinearGradient(0.9, -0.3, -0.7, 0.3);
      fill.addColorStop(0, '#ffffff');
      fill.addColorStop(0.5, COLORS.ice[0]);
      fill.addColorStop(1, COLORS.ice[1]);
      this._playerFill = fill;
    }
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.scale(unit, unit);
    ctx.beginPath();
    ctx.moveTo(0.8, 0);
    ctx.lineTo(-0.6, -0.56);
    ctx.lineTo(-0.27, 0);
    ctx.lineTo(-0.6, 0.56);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.fillStyle = ctx.strokeStyle = tint || this._playerFill;
    ctx.lineWidth = edge;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }

  /** The last cell or two of line up to the arrow, in the line's solid core colours. */
  _drawTrailTip(ctx, view, grid, player) {
    const { trail, trailStart } = grid;
    const a = trail.length >= 2 ? trail[trail.length - 2] : trailStart;
    const b = trail.length >= 3 ? trail[trail.length - 3] : trailStart;
    if (!a) return;
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    ctx.beginPath();
    ctx.moveTo(ox + player.x * cs, oy + player.y * cs);
    ctx.lineTo(ox + a.x * cs, oy + a.y * cs);
    if (b && b !== a) ctx.lineTo(ox + b.x * cs, oy + b.y * cs);
    ctx.strokeStyle = COLORS.trail;
    ctx.lineWidth = Math.max(2, cs * 0.26);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, cs * 0.1);
    ctx.stroke();
  }

  _drawComet(ctx, view, px, py) {
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    const comet = this._comet;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = COLORS.ice[1];
    // Butt caps: each band starts where the last one ended, and overlapping round caps add up to bright beads.
    ctx.lineCap = 'butt';
    let band = 0;
    let lastX = px;
    let lastY = py;
    ctx.beginPath();
    ctx.moveTo(px, py);
    for (let k = 1; k <= this._cometCount; k++) {
      const o = ((this._cometHead - k + COMET_SAMPLES) % COMET_SAMPLES) * 3;
      const age = this._time - comet[o + 2];
      if (age >= COMET_LIFE) break;
      const b = Math.min(COMET_WIDTHS.length - 1, Math.floor((age / COMET_LIFE) * COMET_WIDTHS.length));
      if (b !== band) {
        strokeBand(ctx, cs, band);
        band = b;
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
      }
      lastX = ox + comet[o] * cs;
      lastY = oy + comet[o + 1] * cs;
      ctx.lineTo(lastX, lastY);
    }
    strokeBand(ctx, cs, band);
    ctx.lineCap = 'round';
  }

  _drawSpawnRings(ctx, cs, px, py, p) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = COLORS.ice[0];
    for (let k = 0; k < 2; k++) {
      const q = clamp01(p * 1.8 - k * 0.3);
      if (q <= 0 || q >= 1) continue;
      const e = easeOutCubic(q);
      ctx.globalAlpha = e * (1 - q * q);
      ctx.lineWidth = cs * (0.1 + 0.25 * (1 - e));
      ctx.beginPath();
      ctx.arc(px, py, cs * (0.6 + 4.2 * (1 - e)), 0, TAU);
      ctx.stroke();
    }
  }

  _drawImpact(ctx, view) {
    const cs = view.cellSize;
    const { x, y, angle, t } = this._impact;
    const p = t / IMPACT_LIFE;
    const px = view.offsetX + (x + 0.5) * cs;
    const py = view.offsetY + (y + 0.5) * cs;
    const r = cs * (2.4 + 2.6 * p);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1;
    ctx.drawImage(glowSprite('#ffffff'), px - r, py - r, r * 2, r * 2);
    ctx.globalCompositeOperation = 'source-over';
    this._drawArrow(ctx, px, py, angle, cs * (1 + 0.45 * p), '#ffffff');
  }

  // ── Enemies ──────────────────────────────────────────────────────────────

  _drawSparx(ctx, view, sparx) {
    const cs = view.cellSize;
    const px = view.offsetX + (sparx.x + 0.5) * cs;
    const py = view.offsetY + (sparx.y + 0.5) * cs;
    const flick = Math.floor(sparx.phase * 22); // the crackle re-rolls every few frames, not every frame
    const dim = sparx.homing ? 0.65 : 1;

    ctx.globalCompositeOperation = 'lighter';
    const halo = cs * (1.9 + 0.5 * hash(flick));
    ctx.globalAlpha = dim * (0.7 + 0.3 * hash(flick + 0.5));
    ctx.drawImage(glowSprite(COLORS.sparx), px - halo, py - halo, halo * 2, halo * 2);

    const rays = 4 + Math.floor(hash(flick * 0.37) * 3);
    ctx.beginPath();
    for (let k = 0; k < rays; k++) {
      const a = (k / rays) * TAU + sparx.phase * 1.4 + (hash(flick * 3.1 + k) - 0.5) * 1.1;
      const len = cs * (0.65 + 0.95 * hash(flick * 1.7 + k * 5.3));
      const bend = a + (hash(flick + k * 2.9) - 0.5) * 0.9;
      // Two-piece rays: the kink is what makes it read as electricity rather than a star.
      const mx = px + Math.cos(a) * len * 0.55;
      const my = py + Math.sin(a) * len * 0.55;
      ctx.moveTo(px, py);
      ctx.lineTo(mx, my);
      ctx.lineTo(mx + Math.cos(bend) * len * 0.5, my + Math.sin(bend) * len * 0.5);
    }
    ctx.globalAlpha = dim * 0.85;
    ctx.strokeStyle = COLORS.sparxBurst[2];
    ctx.lineWidth = Math.max(1.5, cs * 0.2);
    ctx.stroke();
    ctx.globalAlpha = dim;
    ctx.strokeStyle = COLORS.sparxBurst[0];
    ctx.lineWidth = Math.max(1, cs * 0.08);
    ctx.stroke();

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = COLORS.sparxBurst[1];
    ctx.beginPath();
    ctx.arc(px, py, cs * 0.36, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fffdf4';
    ctx.beginPath();
    ctx.arc(px, py, cs * 0.22, 0, TAU);
    ctx.fill();
  }

  _drawQix(ctx, view, qix, grid) {
    const state = this._qix.get(qix);
    if (!state) return;
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    const { lines, count, head } = state;

    ctx.globalCompositeOperation = 'lighter';
    const halo = qix.radius * QIX_HALO * cs * (1.7 + 0.2 * Math.sin(qix.phase * 5));
    ctx.globalAlpha = 0.42;
    ctx.drawImage(glowSprite(COLORS.qix), ox + qix.x * cs - halo, oy + qix.y * cs - halo, halo * 2, halo * 2);

    ctx.globalAlpha = 1;
    for (let k = 0; k < count; k++) {
      const o = ((head - count + k + QIX_SEGMENTS) % QIX_SEGMENTS) * 4;
      ctx.strokeStyle = QIX_STYLES[QIX_SEGMENTS - count + k];
      ctx.beginPath();
      ctx.moveTo(ox + lines[o] * cs, oy + lines[o + 1] * cs);
      ctx.lineTo(ox + lines[o + 2] * cs, oy + lines[o + 3] * cs);
      ctx.globalAlpha = 0.16;
      ctx.lineWidth = cs * 0.36;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = Math.max(1.25, cs * 0.11);
      ctx.stroke();
    }

    // The live line, straight from the qix's current phase, is the white-hot leading edge.
    qixEnds(qix, grid, qix.phase, state.seed, LIVE, 0);
    const ax = ox + LIVE[0] * cs;
    const ay = oy + LIVE[1] * cs;
    const bx = ox + LIVE[2] * cs;
    const by = oy + LIVE[3] * cs;
    ctx.strokeStyle = COLORS.qixBurst[1];
    ctx.lineWidth = Math.max(1.5, cs * 0.13);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    const tip = cs * 0.8;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(glowSprite(COLORS.qixBurst[1]), ax - tip, ay - tip, tip * 2, tip * 2);
    ctx.drawImage(glowSprite(COLORS.qixBurst[1]), bx - tip, by - tip, tip * 2, tip * 2);
  }
}

/**
 * Ribbon endpoints at `phase`, written to out[o..o+3]: a stick through the qix that spins at an
 * uneven but never stalling rate while its two arms flex and stretch independently, so the
 * history always fans out into the classic twisting ribbon.
 */
function qixEnds(qix, grid, phase, seed, out, o) {
  const reach = qix.radius * QIX_REACH;
  const ta = phase * 2.2 + seed + 1.2 * Math.sin(phase * 0.9 + seed);
  const tb = ta + Math.PI + 1.1 * Math.sin(phase * 1.7) + 0.6 * Math.sin(phase * 0.9 + seed);
  const ca = Math.cos(ta);
  const sa = Math.sin(ta);
  const cb = Math.cos(tb);
  const sb = Math.sin(tb);
  const ra = clearArm(grid, qix, ca, sa, reach * (0.7 + 0.3 * Math.sin(phase * 3.3 + seed)));
  const rb = clearArm(grid, qix, cb, sb, reach * (0.7 + 0.3 * Math.sin(phase * 2.6 + 1.4)));
  out[o] = qix.x + ca * ra;
  out[o + 1] = qix.y + sa * ra;
  out[o + 2] = qix.x + cb * rb;
  out[o + 3] = qix.y + sb * rb;
}

/**
 * Length of an arm along (ux, uy), cut short of land. The qix only kills a player on the rail within its
 * hit circle, so a ribbon drawn over the rail (or into the ice) would look like a touch that did nothing.
 */
function clearArm(grid, qix, ux, uy, length) {
  if (grid.isSolid(Math.round(qix.x), Math.round(qix.y))) return length; // gliding out of a capture: leave it
  for (let t = 0.25; t <= length + ARM_MARGIN; t += 0.25) {
    if (grid.isSolid(Math.round(qix.x + ux * t), Math.round(qix.y + uy * t))) {
      return Math.max(0.3, Math.min(length, t - 0.25 - ARM_MARGIN));
    }
  }
  return length;
}

function strokeBand(ctx, cs, band) {
  ctx.globalAlpha = COMET_ALPHAS[band];
  ctx.lineWidth = cs * COMET_WIDTHS[band];
  ctx.stroke();
}
