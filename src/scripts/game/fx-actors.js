import { COLORS, DIRS, POWERS } from '../config.js';
import { POWER_BURSTS } from './fx-powers.js';
import { TAU, clamp01, easeOutBack, easeOutCubic, glowSprite, hash } from './fx-util.js';

const COMET_SAMPLES = 160; // one per frame: covers the boosted comet (~0.65 s) up to ~245 Hz
const COMET_LIFE = 0.36; // seconds a ribbon sample stays visible
const COMET_BOOST = 0.8; // extra share of COMET_LIFE while the speed power runs: a longer, golden comet
const COMET_WIDTHS = [0.5, 0.38, 0.26, 0.14]; // cells, newest band → oldest
const COMET_ALPHAS = [0.5, 0.32, 0.18, 0.08];
const SPAWN_LIFE = 0.55;
const SPAWN_POP = 0.3; // moment the rings close and the sparks fly
const IMPACT_LIFE = 0.12; // white freeze-frame of the dying player
const GHOST_LIFE = 0.3; // after-image of a cleared trail
const SLASH_ZIP = 0.1; // seconds an instant cut takes to race out to the land …
const SLASH_LIFE = 0.5; // … and to fade
const SHIELD_RADIUS = 1.15; // cells: the bubble round the arrowhead
const SHIELD_POP = 0.3;
const EMBER_SPACING = 0.3; // cells travelled per sparx ember
const DRAW_SPARK_SPACING = 0.4; // cells travelled per trail-head spark
const BOOST_SPARK_SPACING = 0.3; // cells travelled per afterburner spark
const SPARX_SHELL = 0.62; // cells: frost / sand shell round a sparx core
const SPARX_CRYSTALS = 0.4; // rad: turn of the frost crystals on a sparx
const BOOST = COLORS.powers.speed;
const SHIELD = COLORS.powers.shield;
const CUT = COLORS.powers.cut;
const TRAIL_COLORS = ['#ffffff', COLORS.trail, COLORS.ice[2], COLORS.ice[3]];
const NO_DASH = [];
const NONE = [];
const RIM = 'rgba(2, 12, 44, 0.55)'; // dark edge that lifts the arrow off bright ice

/**
 * Draws the trail and the player and sparx, with the looks the active powers give them, and owns every bit
 * of visual state they need (comet ribbon, ember spacing, spawn / death timers, the instant-cut slash) keyed
 * off the logic objects, which stay animation-free. The free-flying enemies are fx-foes.js's.
 */
export class Actors {
  constructor(effects, look, { lowPower = false } = {}) {
    this.effects = effects;
    this.look = look;
    this.lowPower = lowPower;
    const p = effects.particles;
    this._trailRamp = p.ramp(TRAIL_COLORS);
    this._emberRamp = p.ramp(COLORS.sparxBurst);
    this._boostRamp = p.ramp(POWER_BURSTS.speed);
    this._shieldRamp = p.ramp(POWER_BURSTS.shield);
    this._cutRamp = p.ramp(POWER_BURSTS.cut);
    for (const color of [BOOST, SHIELD, CUT]) glowSprite(color);
    // x, y, time. Float64: a float32 time can round above the clock, and a negative age re-strokes the head.
    this._comet = new Float64Array(COMET_SAMPLES * 3);
    this._dash = [0, 0];
    this._playerFill = null;
    this._bubbleFill = null;
    this.reset();
  }

  /** New level: forget every tracked entity. */
  reset() {
    this._time = 0;
    this._cometHead = 0;
    this._cometCount = 0;
    this._sparkOdometer = 0;
    this._boostOdometer = 0;
    this._last = { x: 0, y: 0, angle: Math.PI / 2, known: false };
    this._trailStart = { x: 0, y: 0, known: false };
    this._spawn = { t: SPAWN_LIFE, popped: true };
    this._impact = { x: 0, y: 0, angle: 0, t: IMPACT_LIFE };
    this._ghost = { points: null, t: GHOST_LIFE };
    this._slash = { points: null, t: SLASH_LIFE };
    this._sparx = new Map();
    this._frame = 0;
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

  /**
   * Instant cut: the auto-drawn line (cells from the player outward) races out to the land as a lime slash.
   * It starts from the player's cell when that is known: the arrowhead stops on a centre right beside cells[0].
   */
  instantCut(cells) {
    if (!cells || !cells.length) return;
    const last = this._last;
    const hx = Math.round(last.x);
    const hy = Math.round(last.y);
    const lead = last.known && Math.abs(hx - cells[0].x) + Math.abs(hy - cells[0].y) === 1 ? 1 : 0;
    const points = new Float32Array((cells.length + lead) * 2);
    if (lead) {
      points[0] = hx;
      points[1] = hy;
    }
    const p = this.effects.particles;
    const perCell = this.lowPower ? 1 : 2;
    for (let k = 0; k < cells.length; k++) {
      const { x, y } = cells[k];
      points[(k + lead) * 2] = x;
      points[(k + lead) * 2 + 1] = y;
      for (let j = 0; j < perCell; j++) {
        const a = Math.random() * TAU;
        const v = 1 + Math.random() * 6;
        p.spawn(x + Math.random() - 0.5, y + Math.random() - 0.5, Math.cos(a) * v, Math.sin(a) * v, 0.3 + Math.random() * 0.4, 0.07 + Math.random() * 0.08, 2.5, 0, this._cutRamp, j === 0 && k % 4 === 0);
      }
    }
    this._slash.points = points;
    this._slash.t = 0;
  }

  /** The shield took a hit: its bubble bursts into cyan motes round the arrowhead. */
  shieldBroke() {
    const { x, y, known } = this._last;
    if (!known) return;
    const p = this.effects.particles;
    const n = this.lowPower ? 20 : 40;
    for (let j = 0; j < n; j++) {
      const a = (j / n) * TAU + Math.random() * 0.15;
      const v = 4 + Math.random() * 6;
      const r = SHIELD_RADIUS;
      p.spawn(x + Math.cos(a) * r, y + Math.sin(a) * r, Math.cos(a) * v, Math.sin(a) * v, 0.3 + Math.random() * 0.3, 0.09 + Math.random() * 0.06, 3, 0, this._shieldRamp, j % 5 === 0);
    }
  }

  // ── Per-frame ────────────────────────────────────────────────────────────

  update(scene, dt) {
    this._time += dt;
    this._spawn.t += dt;
    this._impact.t += dt;
    this._ghost.t += dt;
    this._slash.t += dt;
    if (this._ghost.t >= GHOST_LIFE) this._ghost.points = null;
    if (this._slash.t >= SLASH_LIFE) this._slash.points = null;

    const { grid, player } = scene;
    if (grid.trailStart) {
      this._trailStart.x = grid.trailStart.x;
      this._trailStart.y = grid.trailStart.y;
      this._trailStart.known = true;
    }
    if (player && player.alive) this._trackPlayer(player);
    const frame = ++this._frame;
    let tracked = 0;
    for (const sparx of scene.sparx || NONE) {
      if (sparx.alive === false) continue;
      this._trackSparx(sparx, frame, dt, scene.state);
      tracked++;
    }
    // A sparx gone from the list is forgotten (only walked when something did go).
    if (tracked !== this._sparx.size) {
      for (const [sparx, state] of this._sparx) if (state.seen !== frame) this._sparx.delete(sparx);
    }

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

      // Born at the notch, so they stream out from behind the arrow rather than across it.
      const bx = player.x - Math.cos(player.angle) * 0.35;
      const by = player.y - Math.sin(player.angle) * 0.35;
      const p = this.effects.particles;
      if (player.drawing && step <= 3) {
        this._sparkOdometer += step;
        while (this._sparkOdometer >= DRAW_SPARK_SPACING) {
          this._sparkOdometer -= DRAW_SPARK_SPACING;
          const a = player.angle + Math.PI + (Math.random() - 0.5) * 2.2;
          const v = 1.5 + Math.random() * 5;
          p.spawn(bx, by, Math.cos(a) * v, Math.sin(a) * v, 0.2 + Math.random() * 0.35, 0.06 + Math.random() * 0.07, 3, 0, this._trailRamp, false);
        }
      }
      if (this.look.boost > 0.05 && step <= 3) {
        const spacing = BOOST_SPARK_SPACING * (this.lowPower ? 2 : 1);
        this._boostOdometer += step;
        while (this._boostOdometer >= spacing) {
          this._boostOdometer -= spacing;
          const a = player.angle + Math.PI + (Math.random() - 0.5) * 0.9;
          const v = 3 + Math.random() * 6;
          p.spawn(bx, by, Math.cos(a) * v, Math.sin(a) * v, 0.18 + Math.random() * 0.25, 0.07 + Math.random() * 0.07, 3, 0, this._boostRamp, false);
        }
      }
      last.x = player.x;
      last.y = player.y;
      last.known = true;
    }
    last.angle = player.angle;
  }

  _trackSparx(sparx, frame, dt, gameState) {
    let state = this._sparx.get(sparx);
    if (!state) {
      state = { x: sparx.x, y: sparx.y, odometer: 0, clock: sparx.phase, seen: frame };
      this._sparx.set(sparx, state);
    }
    state.seen = frame;
    // The crackle runs on its own clock, so a sparx parked until the first move still crackles. Time stop eases
    // it to a standstill and slow-mo to the sim's slow factor (the frost wins, as on the shells); a pause or a
    // hit-stop holds it.
    if (gameState !== 'paused') {
      const { frost, sand } = this.look;
      const slow = 1 - (1 - POWERS.slow.factor) * sand * (1 - frost);
      state.clock += dt * this.effects.timeScale * (1 - frost) * slow;
    }
    const step = Math.hypot(sparx.x - state.x, sparx.y - state.y);
    state.x = sparx.x;
    state.y = sparx.y;
    // A relocation snaps it onto the rail: no embers strung across the board.
    if (step > 3) return;
    state.odometer += step;
    while (state.odometer >= EMBER_SPACING) {
      state.odometer -= EMBER_SPACING;
      const a = Math.random() * TAU;
      const v = Math.random() * 1.6;
      this.effects.particles.spawn(sparx.x, sparx.y, Math.cos(a) * v, Math.sin(a) * v, 0.25 + Math.random() * 0.4, 0.09 + Math.random() * 0.08, 2, 0, this._emberRamp, false);
    }
  }

  /** Lines on the board, under every body: a cleared trail's after-image, the instant-cut slash, the trail. */
  drawLines(ctx, view, scene) {
    const { grid, player } = scene;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (this._ghost.points) this._drawGhost(ctx, view);
    if (grid.trail.length) this._drawTrail(ctx, view, grid, player);
    if (this._slash.points) this._drawSlash(ctx, view);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** The sparx and the player (or its death frame), above the enemies. view = the Renderer. */
  drawBodies(ctx, view, scene) {
    const { grid, player } = scene;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const sparx of scene.sparx || NONE) if (sparx.alive !== false) this._drawSparx(ctx, view, sparx);
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

    // Shield: a cyan sheath round the whole line, the part a qix would otherwise cut.
    const sheath = this.look.sheath;
    if (sheath > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = SHIELD;
      ctx.globalAlpha = 0.24 * sheath;
      ctx.lineWidth = cs * 1.1;
      ctx.stroke();
      ctx.globalAlpha = 0.7 * sheath;
      ctx.lineWidth = Math.max(1.5, cs * 0.16);
      ctx.stroke();
    }

    // Energy pulses streaming from the origin toward the arrow.
    this._dash[0] = cs * 0.55;
    this._dash[1] = cs * 2.6;
    ctx.setLineDash(this._dash);
    ctx.lineDashOffset = -this._time * cs * 17;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#ffffff';
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

  /** The instant cut: a lime slash racing from the arrowhead to the land, then burning out. */
  _drawSlash(ctx, view) {
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    const { points, t } = this._slash;
    const count = points.length / 2;
    const fade = t < SLASH_ZIP ? 1 : 1 - (t - SLASH_ZIP) / (SLASH_LIFE - SLASH_ZIP);
    // Points are whole cells apart, so the share of the run maps straight onto them.
    const reach = clamp01(t / SLASH_ZIP) * (count - 1);
    const whole = Math.floor(reach);
    let hx = ox + points[0] * cs;
    let hy = oy + points[1] * cs;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    for (let k = 1; k <= whole; k++) {
      hx = ox + points[k * 2] * cs;
      hy = oy + points[k * 2 + 1] * cs;
      ctx.lineTo(hx, hy);
    }
    if (whole < count - 1) {
      const f = reach - whole;
      hx += (ox + points[whole * 2 + 2] * cs - hx) * f;
      hy += (oy + points[whole * 2 + 3] * cs - hy) * f;
      ctx.lineTo(hx, hy);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = CUT;
    ctx.globalAlpha = 0.35 * fade;
    ctx.lineWidth = cs * (0.9 + 0.9 * (1 - fade));
    ctx.stroke();
    ctx.globalAlpha = 0.85 * fade;
    ctx.lineWidth = Math.max(2, cs * 0.32);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = fade;
    ctx.lineWidth = Math.max(1.5, cs * 0.12);
    ctx.stroke();
    if (t < SLASH_ZIP * 1.5) {
      const g = cs * 1.6;
      ctx.globalAlpha = 1;
      ctx.drawImage(glowSprite(CUT), hx - g, hy - g, g * 2, g * 2);
    }
  }

  // ── Player ───────────────────────────────────────────────────────────────

  _drawPlayer(ctx, view, player, grid) {
    const cs = view.cellSize;
    const px = view.offsetX + (player.x + 0.5) * cs;
    const py = view.offsetY + (player.y + 0.5) * cs;
    const time = this._time;
    const spawn = this._spawn;
    const look = this.look;
    const boost = look.boost * look.boostFlicker;

    if (this._cometCount) {
      this._drawComet(ctx, view, px, py, COLORS.ice[1], COMET_LIFE * (1 + COMET_BOOST * look.boost), 1);
      if (boost > 0.01) this._drawComet(ctx, view, px, py, BOOST, COMET_LIFE * (1 + COMET_BOOST * look.boost), boost);
    }
    // Only while a cut is really armed: once it has fired, the next line must not show where it would land.
    if (look.powers.cut && look.cut > 0.01 && player.drawing) this._drawCutPreview(ctx, view, grid, player, look.cut);

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
    if (boost > 0.01 && player.moving && scale > 0.01) this._drawAfterburner(ctx, cs, px, py, player.angle, boost * Math.min(1, scale));

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
      if (look.cut > 0.01) this._drawCutGlint(ctx, cs, px, py, player.angle, cs * scale, look.cut);
      const shield = look.shield * look.shieldFlicker;
      if (shield > 0.01) this._drawShield(ctx, cs, px, py, shield * Math.min(1, scale));
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

  /** The ribbon behind the arrow, newest → oldest in fading bands. `gain` scales its alpha. */
  _drawComet(ctx, view, px, py, color, life, gain) {
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    const comet = this._comet;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = color;
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
      if (age >= life) break;
      const b = Math.min(COMET_WIDTHS.length - 1, Math.floor((age / life) * COMET_WIDTHS.length));
      if (b !== band) {
        strokeBand(ctx, cs, band, gain);
        band = b;
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
      }
      lastX = ox + comet[o] * cs;
      lastY = oy + comet[o + 1] * cs;
      ctx.lineTo(lastX, lastY);
    }
    strokeBand(ctx, cs, band, gain);
    ctx.lineCap = 'round';
  }

  /** Speed power: a flickering golden flame out of the notch. */
  _drawAfterburner(ctx, cs, px, py, angle, level) {
    const flick = 0.8 + 0.4 * hash(Math.floor(this._time * 30));
    const len = cs * (0.75 + 0.55 * flick);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const bx = px - c * cs * 0.3;
    const by = py - s * cs * 0.3;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.6 * level;
    const g = cs * 1.1 * flick;
    ctx.drawImage(glowSprite(BOOST), bx - c * len * 0.5 - g, by - s * len * 0.5 - g, g * 2, g * 2);
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -cs * 0.22);
    ctx.quadraticCurveTo(-len * 0.5, -cs * 0.16, -len, 0);
    ctx.quadraticCurveTo(-len * 0.5, cs * 0.16, 0, cs * 0.22);
    ctx.closePath();
    ctx.fillStyle = BOOST;
    ctx.globalAlpha = 0.75 * level;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -cs * 0.1);
    ctx.quadraticCurveTo(-len * 0.3, -cs * 0.07, -len * 0.55, 0);
    ctx.quadraticCurveTo(-len * 0.3, cs * 0.07, 0, cs * 0.1);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.9 * level;
    ctx.fill();
    ctx.restore();
  }

  /** Cut armed: a lime glint winking on the arrow's nose. */
  _drawCutGlint(ctx, cs, px, py, angle, unit, level) {
    const tx = px + Math.cos(angle) * unit * 0.8;
    const ty = py + Math.sin(angle) * unit * 0.8;
    const pulse = 0.5 + 0.5 * Math.sin(this._time * 7);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.75 * level;
    const g = cs * (0.75 + 0.3 * pulse);
    ctx.drawImage(glowSprite(CUT), tx - g, ty - g, g * 2, g * 2);
    const arm = cs * (0.4 + 0.2 * pulse);
    const waist = cs * 0.07;
    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(this._time * 2);
    ctx.beginPath();
    ctx.moveTo(arm, 0);
    ctx.lineTo(waist, waist);
    ctx.lineTo(0, arm);
    ctx.lineTo(-waist, waist);
    ctx.lineTo(-arm, 0);
    ctx.lineTo(-waist, -waist);
    ctx.lineTo(0, -arm);
    ctx.lineTo(waist, -waist);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = level;
    ctx.fill();
    ctx.restore();
  }

  /**
   * Cut armed while drawing: a faint dashed lime line from the arrow to where the cut would land. The cut
   * fires at the next centre along the current heading (the cell being entered), so that is where it starts.
   */
  _drawCutPreview(ctx, view, grid, player, level) {
    const step = DIRS[player.dir];
    const from = player.target;
    // Bound for land: that arrival closes the line the ordinary way and the cut stays armed for the next one.
    if (!step || !from || grid.isSolid(from.x, from.y)) return;
    let x = from.x;
    let y = from.y;
    while (grid.isEmpty(x + step.x, y + step.y)) {
      x += step.x;
      y += step.y;
    }
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    const ex = ox + (x + step.x * 0.5) * cs;
    const ey = oy + (y + step.y * 0.5) * cs;
    this._dash[0] = cs * 0.3;
    this._dash[1] = cs * 0.35;
    ctx.setLineDash(this._dash);
    ctx.lineDashOffset = -this._time * cs * 6;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = CUT;
    ctx.globalAlpha = 0.5 * level;
    ctx.lineWidth = Math.max(1, cs * 0.1);
    ctx.beginPath();
    ctx.moveTo(ox + player.x * cs, oy + player.y * cs);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    // A tick across the line where it meets the land.
    ctx.lineWidth = Math.max(1.5, cs * 0.14);
    ctx.globalAlpha = 0.8 * level;
    ctx.beginPath();
    ctx.moveTo(ex - step.y * cs * 0.4, ey - step.x * cs * 0.4);
    ctx.lineTo(ex + step.y * cs * 0.4, ey + step.x * cs * 0.4);
    ctx.stroke();
  }

  /** Shield: a cyan glass bubble with energy running round its rim; it pops in, and flickers as it runs out. */
  _drawShield(ctx, cs, px, py, level) {
    const look = this.look;
    const time = this._time;
    const pop = look.shieldAge < SHIELD_POP ? easeOutBack(clamp01(look.shieldAge / SHIELD_POP), 2.2) : 1;
    const r = cs * SHIELD_RADIUS * pop * (1 + 0.03 * Math.sin(time * 5));
    if (r < 0.5) return;
    if (!this._bubbleFill) {
      const fill = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      fill.addColorStop(0, 'rgba(89, 240, 255, 0)');
      fill.addColorStop(0.62, 'rgba(89, 240, 255, 0.05)');
      fill.addColorStop(0.92, 'rgba(89, 240, 255, 0.3)');
      fill.addColorStop(1, 'rgba(200, 252, 255, 0.55)');
      this._bubbleFill = fill;
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.3 * level;
    const halo = r * 1.6;
    ctx.drawImage(glowSprite(SHIELD), px - halo, py - halo, halo * 2, halo * 2);

    ctx.save();
    ctx.translate(px, py);
    ctx.scale(r, r);
    const lw = 1 / r;
    ctx.globalAlpha = level;
    ctx.fillStyle = this._bubbleFill;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = SHIELD;
    ctx.globalAlpha = 0.9 * level;
    ctx.lineWidth = Math.max(1.5, cs * 0.08) * lw;
    ctx.stroke();
    const a = time * 1.7;
    ctx.beginPath();
    ctx.arc(0, 0, 0.97, a, a + 1.1);
    ctx.moveTo(Math.cos(a + Math.PI) * 0.97, Math.sin(a + Math.PI) * 0.97);
    ctx.arc(0, 0, 0.97, a + Math.PI, a + Math.PI + 0.8);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * lw;
    ctx.stroke();
    ctx.globalAlpha = 0.6 * level;
    ctx.lineWidth = Math.max(lw, 0.08);
    ctx.beginPath();
    ctx.arc(0, 0, 0.72, Math.PI * 1.1, Math.PI * 1.4);
    ctx.stroke();
    ctx.restore();
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

  // ── Sparx ────────────────────────────────────────────────────────────────

  _drawSparx(ctx, view, sparx) {
    const cs = view.cellSize;
    const px = view.offsetX + (sparx.x + 0.5) * cs;
    const py = view.offsetY + (sparx.y + 0.5) * cs;
    const t = this._sparx.get(sparx)?.clock ?? sparx.phase;
    const flick = Math.floor(t * 22); // the crackle re-rolls every few frames, not every frame
    const dim = sparx.homing ? 0.65 : 1;
    // Frozen sparks: the crackle stands still (the frost holds its clock); the rays also cool under the ice.
    const rays = 1 - 0.55 * this.look.frost;

    ctx.globalCompositeOperation = 'lighter';
    const halo = cs * (1.9 + 0.5 * hash(flick));
    ctx.globalAlpha = dim * (0.7 + 0.3 * hash(flick + 0.5));
    ctx.drawImage(glowSprite(COLORS.sparx), px - halo, py - halo, halo * 2, halo * 2);

    const count = 4 + Math.floor(hash(flick * 0.37) * 3);
    ctx.beginPath();
    for (let k = 0; k < count; k++) {
      const a = (k / count) * TAU + t * 1.4 + (hash(flick * 3.1 + k) - 0.5) * 1.1;
      const len = cs * (0.65 + 0.95 * hash(flick * 1.7 + k * 5.3));
      const bend = a + (hash(flick + k * 2.9) - 0.5) * 0.9;
      // Two-piece rays: the kink is what makes it read as electricity rather than a star.
      const mx = px + Math.cos(a) * len * 0.55;
      const my = py + Math.sin(a) * len * 0.55;
      ctx.moveTo(px, py);
      ctx.lineTo(mx, my);
      ctx.lineTo(mx + Math.cos(bend) * len * 0.5, my + Math.sin(bend) * len * 0.5);
    }
    ctx.globalAlpha = dim * 0.85 * rays;
    ctx.strokeStyle = COLORS.sparxBurst[2];
    ctx.lineWidth = Math.max(1.5, cs * 0.2);
    ctx.stroke();
    ctx.globalAlpha = dim * rays;
    ctx.strokeStyle = COLORS.sparxBurst[0];
    ctx.lineWidth = Math.max(1, cs * 0.08);
    ctx.stroke();

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = dim;
    ctx.fillStyle = COLORS.sparxBurst[1];
    ctx.beginPath();
    ctx.arc(px, py, cs * 0.36, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fffdf4';
    ctx.beginPath();
    ctx.arc(px, py, cs * 0.22, 0, TAU);
    ctx.fill();
    this.look.shells(ctx, px, py, cs * SPARX_SHELL, cs, SPARX_CRYSTALS);
  }
}

function strokeBand(ctx, cs, band, gain) {
  ctx.globalAlpha = COMET_ALPHAS[band] * gain;
  ctx.lineWidth = cs * COMET_WIDTHS[band];
  ctx.stroke();
}
