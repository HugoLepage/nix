import { COLORS } from '../config.js';
import { TAU, approach, clamp01, easeOutCubic, glowSprite, hash } from './fx-util.js';

const HISTORY = 8; // after-image samples kept per foe
const HISTORY_STEP = 0.03; // seconds of the foe's own clock between samples
const GHOSTS = HISTORY - 1; // qix after-images: one per sample behind the newest
const GHOST_ALPHA = 0.3; // the nearest after-image; the rest fade out down the tail
const GHOST_SWAY = 0.35; // × radius: how far the tail's end swings across the line of flight
const EMBER_SPACING = 0.4; // cells flown per ember shed off a qix's tail
const TELEPORT = 3; // cells moved in one frame: a launch or a relocation, never flight
// Draw order: seekers last, being the smallest and the one that hunts. Spawners above qix, so a fresh
// qix slides out from under the port that fired it.
const LAYER = { qix: 0, chipper: 0, spawner: 1, seeker: 2 };
const LAYERS = 3;
const SHELL = { qix: 1, chipper: 0.94, seeker: 1.32, spawner: 1 }; // frost / sand shell radius, × radius
const FILAMENTS = 3;
const SPIKES = 9;
const SPIKE_BASE = 0.5; // × radius: where a spike leaves the core
const SPIKE_HALF = 0.3; // rad: half the angle a spike's base spans
const CHIPPER_CORE = 0.62; // × radius
const FLASH_LIFE = 0.16; // seconds the spikes stay white-hot after an impact
const PORT_RING = 0.56; // × radius: where the spawner's holes sit
const PORT_HOLE = 0.22; // × radius
const PORT_TILT = 0.8; // holes off the centre face away from us: foreshortened across the radius
const LAUNCH_LIFE = 0.35;
const RADAR_IDLE = 1.6; // seconds per radar pulse …
const RADAR_LOCKED = 0.6; // … and once it has locked on
const LOCK_RATE = 8; // 1 / s
const EXHAUST_SPACING = 0.22; // cells travelled per exhaust puff at full boost
const CHARGE_SPARKS = 26; // inbound sparks per second of the spawner's clock, at full charge
// Seeker bullet, unit = radius, nose along +x.
const TAIL = -0.82;
const NOSE = 1.16;
const BODY = 0.56; // half height
const SEEKER_RIM = 'rgba(2, 34, 18, 0.6)';
const SEEKER_FIN = '#3fc47c';
const SEEKER_BAND = '#2f9e63';
const SEEKER_VISOR = '#06321c';
const CHIPPER_RIM = 'rgba(46, 4, 14, 0.75)';
const PORT_LIP = 'rgba(6, 1, 18, 0.9)';
const FROST_COLORS = ['#ffffff', COLORS.powers.freeze, COLORS.ice[0], COLORS.ice[1]];
const NONE = [];

// Spike outlines in unit space (base, tip, base); ctx.rotate(spin) turns them at draw time.
const SPIKE_PATH = new Float32Array(SPIKES * 6);
for (let k = 0; k < SPIKES; k++) {
  const a = (k * TAU) / SPIKES;
  const o = k * 6;
  SPIKE_PATH[o] = Math.cos(a - SPIKE_HALF) * SPIKE_BASE;
  SPIKE_PATH[o + 1] = Math.sin(a - SPIKE_HALF) * SPIKE_BASE;
  SPIKE_PATH[o + 2] = Math.cos(a);
  SPIKE_PATH[o + 3] = Math.sin(a);
  SPIKE_PATH[o + 4] = Math.cos(a + SPIKE_HALF) * SPIKE_BASE;
  SPIKE_PATH[o + 5] = Math.sin(a + SPIKE_HALF) * SPIKE_BASE;
}
const ENDS = new Float32Array(FILAMENTS * 2); // scratch: filament ends of the orb being drawn

/**
 * Draws every free-flying enemy, dispatching on `foe.kind`: the qix plasma orb, the chipper, the seeker and
 * the spawner. Their visual state (after-images, radar, exhaust, launch flash) lives here, in a Map keyed by
 * the logic object, so the logic stays animation-free. Every body is drawn at `foe.radius`: what you see is
 * what hits.
 */
export class Foes {
  constructor(effects, look, { lowPower = false } = {}) {
    this.effects = effects;
    this.look = look;
    this.lowPower = lowPower;
    const p = effects.particles;
    this._ramps = {
      qix: p.ramp(COLORS.qixBurst),
      chipper: p.ramp(COLORS.chipperBurst),
      seeker: p.ramp(COLORS.seekerBurst),
      spawner: p.ramp(COLORS.spawnerBurst),
    };
    this._frostRamp = p.ramp(FROST_COLORS);
    this._fills = null;
    this._frame = 0;
    // Baked now rather than on the frame a new enemy first shows up.
    for (const color of [COLORS.qix, COLORS.qixBurst[1], COLORS.chipper, COLORS.seeker, COLORS.spawner, COLORS.spawnerBurst[1], '#ffffff']) {
      glowSprite(color);
    }
    glowSprite(COLORS.qix, 'flat');
    glowSprite(COLORS.seeker, 'soft');
    this.reset();
  }

  /** New level: forget every tracked foe. */
  reset() {
    this._states = new Map();
  }

  // ── Moments ──────────────────────────────────────────────────────────────

  /** The foe's own shatter, shaped by its kind; the renderer adds the generic blast around it. */
  destroyed(foe) {
    const state = this._states.get(foe);
    this._states.delete(foe);
    const p = this.effects.particles;
    const ramp = this._ramps[foe.kind] ?? this._ramps.qix;
    const share = this.lowPower ? 0.5 : 1;
    const r = foe.radius || 1;
    const { x, y } = foe;
    if (foe.kind === 'chipper' || foe.kind === 'spawner') {
      // Spikes fly off along their own lines; a spawner vents a jet from every port.
      const spikes = foe.kind === 'chipper';
      const rays = spikes ? SPIKES : Math.max(1, foe.ports | 0);
      const per = Math.round((spikes ? 12 : 26) * share);
      const from = spikes ? 0.5 : PORT_RING;
      for (let k = 0; k < rays; k++) {
        const a = (foe.spin || 0) + (k * TAU) / rays;
        for (let j = 0; j < per; j++) {
          const b = a + (Math.random() - 0.5) * (spikes ? 0.25 : 0.5);
          const v = (spikes ? 6 : 4) + Math.random() * 18;
          const d = r * (from + Math.random() * (1 - from));
          p.spawn(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.cos(b) * v, Math.sin(b) * v, 0.4 + Math.random() * 0.6, 0.1 + Math.random() * 0.1, 2.2, 0, ramp, j === 0);
        }
      }
    } else if (foe.kind === 'seeker') {
      // Hull fragments, flung mostly back along the line it flew.
      const back = (foe.heading || 0) + Math.PI;
      const n = Math.round(80 * share);
      for (let j = 0; j < n; j++) {
        const b = j % 3 ? back + (Math.random() - 0.5) * 1.6 : Math.random() * TAU;
        const v = 3 + Math.random() * 14;
        p.spawn(x, y, Math.cos(b) * v, Math.sin(b) * v, 0.35 + Math.random() * 0.6, 0.09 + Math.random() * 0.09, 2.4, 0, ramp, j < 4);
      }
    } else {
      // The orb's filaments break into shards along their last arcs.
      const seed = state ? state.seed : 0;
      const t = foe.phase || 0;
      const per = Math.round(40 * share);
      for (let k = 0; k < FILAMENTS; k++) {
        const a = seed + (k * TAU) / FILAMENTS + t * 1.3;
        for (let j = 0; j < per; j++) {
          const f = Math.random();
          const b = a + f * 0.9;
          const sx = x + Math.cos(b) * r * (0.12 + 0.8 * f);
          const sy = y + Math.sin(b) * r * (0.12 + 0.8 * f);
          const out = Math.atan2(sy - y, sx - x) + (Math.random() - 0.5) * 0.8;
          const v = 2 + Math.random() * 12;
          p.spawn(sx, sy, Math.cos(out) * v, Math.sin(out) * v, 0.5 + Math.random() * 0.9, 0.1 + Math.random() * 0.1, 2.4, 0, ramp, false);
        }
      }
    }
  }

  /** A spawner fired from `spawner.nextPort`: that port flares and the shell recoils. */
  launched(spawner) {
    const state = this._states.get(spawner);
    if (!state) return;
    state.launch = 0;
    state.port = spawner.nextPort;
  }

  /** A chipper struck something at (x, y): the nearest one's spikes flash white-hot. */
  impact(x, y) {
    let best = null;
    let gap = 1.5;
    for (const [foe, state] of this._states) {
      if (foe.kind !== 'chipper') continue;
      const d = Math.hypot(foe.x - x, foe.y - y) - (foe.radius || 0);
      if (d < gap) {
        gap = d;
        best = state;
      }
    }
    if (best) best.flash = FLASH_LIFE;
  }

  // ── Per-frame ────────────────────────────────────────────────────────────

  update(foes = NONE, dt) {
    const frame = ++this._frame;
    let tracked = 0;
    for (const foe of foes) {
      if (foe.alive === false) continue;
      tracked++;
      const state = this._track(foe);
      state.seen = frame;
      const moved = Math.hypot(foe.x - state.x, foe.y - state.y);
      if (moved > TELEPORT) state.count = 0;
      const phase = foe.phase || 0;
      const tick = Math.min(0.25, Math.max(0, phase - state.phase));
      state.phase = phase;
      // Sampled on the foe's own clock: a frozen, slowed or paused foe keeps its after-images where they were.
      if (phase < state.sampled) state.sampled = phase;
      if (!state.count || phase - state.sampled >= HISTORY_STEP) {
        state.sampled = phase;
        state.hx[state.head] = foe.x;
        state.hy[state.head] = foe.y;
        state.head = (state.head + 1) % HISTORY;
        state.count = Math.min(HISTORY, state.count + 1);
      }
      state.flash = Math.max(0, state.flash - dt);
      state.launch += dt;
      if (foe.kind === 'seeker') this._trackSeeker(foe, state, tick, moved, dt);
      else if (foe.kind === 'spawner') this._trackSpawner(foe, state, tick);
      else if (foe.kind === 'qix') this._trackQix(foe, state, moved);
      if (this.look.froze) this._frostBurst(foe);
      state.x = foe.x;
      state.y = foe.y;
    }
    // Anything gone from the list without a destroyed() call (level logic, a restart) is dropped here.
    if (tracked === this._states.size) return;
    for (const [foe, state] of this._states) if (state.seen !== frame) this._states.delete(foe);
  }

  _track(foe) {
    let state = this._states.get(foe);
    if (!state) {
      const phase = foe.phase || 0;
      state = {
        seen: 0, x: foe.x, y: foe.y, phase, sampled: phase, seed: hash(this._frame * 0.61 + this._states.size * 2.39) * TAU,
        hx: new Float32Array(HISTORY), hy: new Float32Array(HISTORY), head: 0, count: 0,
        flash: 0, launch: LAUNCH_LIFE, port: -1, locked: !!foe.locked, lock: foe.locked ? 1 : 0, radar: 0, odometer: 0, charge: 0,
      };
      this._states.set(foe, state);
    }
    return state;
  }

  _trackSeeker(foe, state, tick, moved, dt) {
    const locked = !!foe.locked;
    // The lock-on ping. Not while frozen: nothing on a frozen enemy moves, its radar included.
    if (locked && !state.locked && this.look.frost < 0.5) {
      this.effects.shockwave(foe.x, foe.y, { color: COLORS.seeker, radius: 3.2, life: 0.4, width: 0.22 });
    }
    state.locked = locked;
    state.lock = approach(state.lock, locked ? 1 : 0, LOCK_RATE, dt);
    // Advanced by the foe's clock at a period eased between idle and locked: no jump when it locks on.
    state.radar = (state.radar + tick / (RADAR_IDLE + (RADAR_LOCKED - RADAR_IDLE) * state.lock)) % 1;

    const boost = clamp01(foe.boost || 0);
    if (boost < 0.08 || moved > TELEPORT) return;
    state.odometer += moved * boost;
    const spacing = EXHAUST_SPACING * (this.lowPower ? 2 : 1);
    if (state.odometer < spacing) return;
    const heading = foe.heading || 0;
    const tx = foe.x - Math.cos(heading) * foe.radius * 1.05;
    const ty = foe.y - Math.sin(heading) * foe.radius * 1.05;
    const p = this.effects.particles;
    while (state.odometer >= spacing) {
      state.odometer -= spacing;
      const a = heading + Math.PI + (Math.random() - 0.5) * 0.6;
      const v = 2 + Math.random() * 6 * boost;
      p.spawn(tx, ty, Math.cos(a) * v, Math.sin(a) * v, 0.22 + Math.random() * 0.3, 0.07 + Math.random() * 0.07, 2.5, 0, this._ramps.seeker, false);
    }
  }

  /** Embers shed off the back of the orb, by distance flown: none while it is frozen, fewer while slowed. */
  _trackQix(foe, state, moved) {
    if (moved > TELEPORT) return;
    state.odometer += moved;
    const spacing = EMBER_SPACING * (this.lowPower ? 2 : 1);
    if (state.odometer < spacing) return;
    const back = (foe.heading || 0) + Math.PI;
    const r = foe.radius || 1;
    const p = this.effects.particles;
    while (state.odometer >= spacing) {
      state.odometer -= spacing;
      const a = back + (Math.random() - 0.5) * 2.2; // somewhere on the trailing half of the glass
      const v = 1 + Math.random() * 3;
      p.spawn(foe.x + Math.cos(a) * r * 0.85, foe.y + Math.sin(a) * r * 0.85, Math.cos(a) * v, Math.sin(a) * v, 0.25 + Math.random() * 0.35, 0.06 + Math.random() * 0.06, 3, 0, this._ramps.qix, false);
    }
  }

  /** Sparks drawn into the port that is about to fire, on the spawner's own clock. */
  _trackSpawner(foe, state, tick) {
    const charge = clamp01(foe.charge || 0);
    if (charge < 0.55 || !tick) return;
    state.charge += tick * CHARGE_SPARKS * ((charge - 0.55) / 0.45) * (this.lowPower ? 0.5 : 1);
    if (state.charge < 1) return;
    const a = (foe.spin || 0) + ((foe.nextPort | 0) * TAU) / Math.max(1, foe.ports | 0);
    const hx = foe.x + Math.cos(a) * foe.radius * PORT_RING;
    const hy = foe.y + Math.sin(a) * foe.radius * PORT_RING;
    const p = this.effects.particles;
    while (state.charge >= 1) {
      state.charge -= 1;
      const b = a + (Math.random() - 0.5) * 2.4;
      const d = 0.8 + Math.random() * 0.9;
      const life = 0.2 + Math.random() * 0.12;
      p.spawn(hx + Math.cos(b) * d, hy + Math.sin(b) * d, (-Math.cos(b) * d) / life, (-Math.sin(b) * d) / life, life, 0.07 + Math.random() * 0.05, 0, 0, this._ramps.qix, false);
    }
  }

  /** Time stop: a puff of ice crystals on every enemy as the frost grabs it. */
  _frostBurst(foe) {
    const p = this.effects.particles;
    const n = this.lowPower ? 7 : 14;
    const r = (foe.radius || 1) * (SHELL[foe.kind] ?? 1);
    for (let j = 0; j < n; j++) {
      const a = Math.random() * TAU;
      const v = 1 + Math.random() * 4;
      p.spawn(foe.x + Math.cos(a) * r, foe.y + Math.sin(a) * r, Math.cos(a) * v, Math.sin(a) * v, 0.3 + Math.random() * 0.4, 0.08 + Math.random() * 0.08, 3, 0, this._frostRamp, j < 2);
    }
  }

  /** view = the Renderer; ctx is in CSS pixels with the shake already applied. */
  draw(ctx, view, foes = NONE) {
    if (!foes.length) return;
    if (!this._fills) this._fills = makeFills(ctx);
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let layer = 0; layer < LAYERS; layer++) {
      for (const foe of foes) {
        if (foe.alive === false || (LAYER[foe.kind] ?? 0) !== layer) continue;
        const state = this._states.get(foe);
        if (!state) continue; // joined the list after this frame's update: drawn from the next frame on
        const px = ox + foe.x * cs;
        const py = oy + foe.y * cs;
        switch (foe.kind) {
          case 'chipper':
            this._drawChipper(ctx, cs, px, py, foe, state);
            break;
          case 'seeker':
            this._drawSeeker(ctx, cs, px, py, foe, state);
            break;
          case 'spawner':
            this._drawSpawner(ctx, cs, px, py, foe, state);
            break;
          default:
            this._drawQix(ctx, cs, ox, oy, px, py, foe, state);
        }
        this.look.shells(ctx, px, py, foe.radius * (SHELL[foe.kind] ?? 1) * cs, cs, state.seed);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ── Qix: a plasma orb ────────────────────────────────────────────────────

  _drawQix(ctx, cs, ox, oy, px, py, foe, state) {
    const r = foe.radius * cs;
    const t = foe.phase || 0;

    // After-images along the path it really flew, bounces included. A shimmer runs down them and they sway
    // across the line of flight, more toward the end, so the tail writhes; all on the foe's clock, so it freezes too.
    ctx.globalCompositeOperation = 'lighter';
    const flat = glowSprite(COLORS.qix, 'flat');
    let ax = px; // the after-image ahead of the one being drawn
    let ay = py;
    for (let back = 1; back <= GHOSTS && back < state.count; back++) {
      const i = (state.head - 1 - back + HISTORY * 2) % HISTORY;
      const f = back / GHOSTS; // 0 at the orb → 1 at the tail's end
      let gx = ox + state.hx[i] * cs;
      let gy = oy + state.hy[i] * cs;
      const dx = ax - gx;
      const dy = ay - gy;
      ax = gx;
      ay = gy;
      const len = Math.hypot(dx, dy);
      if (len > 0.5) {
        const sway = (r * GHOST_SWAY * f * Math.sin(t * 9 - back * 1.2)) / len;
        gx -= dy * sway;
        gy += dx * sway;
      }
      const g = r * (0.92 - 0.42 * f) * (1 + 0.14 * Math.sin(t * 13 - back * 0.9));
      ctx.globalAlpha = GHOST_ALPHA * (1 - f + 0.5 / GHOSTS) ** 1.3 * (0.72 + 0.28 * Math.sin(t * 17 - back * 1.4));
      ctx.drawImage(flat, gx - g, gy - g, g * 2, g * 2);
    }
    const halo = r * 2.5 * (1 + 0.07 * Math.sin(t * 5.3));
    ctx.globalAlpha = 0.42;
    ctx.drawImage(glowSprite(COLORS.qix), px - halo, py - halo, halo * 2, halo * 2);

    ctx.save();
    ctx.translate(px, py);
    ctx.scale(r, r);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = this._fills.orb;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, TAU);
    ctx.fill();

    // Filaments from the core to the glass, like a plasma globe; the flicker re-rolls every few frames.
    const flick = Math.floor(t * 16);
    ctx.beginPath();
    for (let k = 0; k < FILAMENTS; k++) {
      const a = state.seed + (k * TAU) / FILAMENTS + t * (k === 1 ? -1.7 : 1.3 + 0.3 * k);
      const bend = 0.7 + 0.45 * Math.sin(t * 2.1 + k * 1.9) + (hash(flick + k * 3.7) - 0.5) * 0.35;
      const mid = a + bend * 0.45;
      const ex = Math.cos(a + bend) * 0.92;
      const ey = Math.sin(a + bend) * 0.92;
      ctx.moveTo(Math.cos(a) * 0.12, Math.sin(a) * 0.12);
      ctx.quadraticCurveTo(Math.cos(mid) * 0.7, Math.sin(mid) * 0.7, ex, ey);
      ENDS[k * 2] = ex;
      ENDS[k * 2 + 1] = ey;
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = COLORS.qixBurst[1];
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 0.17;
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = Math.max(1 / r, 0.05);
    ctx.stroke();
    const spark = glowSprite(COLORS.qixBurst[1]);
    ctx.globalAlpha = 0.9;
    for (let k = 0; k < FILAMENTS; k++) ctx.drawImage(spark, ENDS[k * 2] - 0.26, ENDS[k * 2 + 1] - 0.26, 0.52, 0.52);
    const core = 0.5 + 0.06 * Math.sin(t * 9);
    ctx.drawImage(glowSprite('#ffffff'), -core, -core, core * 2, core * 2);

    // Glass: a thin bright rim, a soft reflection low right, a hard glint top left.
    ctx.globalCompositeOperation = 'source-over';
    const lw = Math.max(1, cs * 0.07) / r;
    ctx.strokeStyle = COLORS.qixBurst[1];
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(0, 0, 1 - lw / 2, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 0.07;
    ctx.beginPath();
    ctx.arc(0, 0, 0.78, 0.35, 1.25);
    ctx.stroke();
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(-0.4, -0.44, 0.25, 0.11, -0.75, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // ── Chipper: a spiked ball ───────────────────────────────────────────────

  _drawChipper(ctx, cs, px, py, foe, state) {
    const r = foe.radius * cs;
    const spin = foe.spin || 0;
    const hot = state.flash / FLASH_LIFE; // 1 → 0 just after an impact

    ctx.globalCompositeOperation = 'lighter';
    const halo = r * (2.2 + 0.5 * hot);
    ctx.globalAlpha = 0.42 + 0.35 * hot;
    ctx.drawImage(glowSprite(COLORS.chipper), px - halo, py - halo, halo * 2, halo * 2);

    ctx.save();
    ctx.translate(px, py);
    ctx.scale(r, r);
    ctx.rotate(spin);
    const lw = Math.max(1, cs * 0.05) / r;
    ctx.beginPath();
    for (let k = 0; k < SPIKES; k++) {
      const o = k * 6;
      ctx.moveTo(SPIKE_PATH[o], SPIKE_PATH[o + 1]);
      ctx.lineTo(SPIKE_PATH[o + 2], SPIKE_PATH[o + 3]);
      ctx.lineTo(SPIKE_PATH[o + 4], SPIKE_PATH[o + 5]);
      ctx.closePath();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = CHIPPER_RIM;
    ctx.lineWidth = lw * 2;
    ctx.stroke();
    ctx.fillStyle = this._fills.spikes;
    ctx.fill();
    // White-hot tips.
    ctx.beginPath();
    for (let k = 0; k < SPIKES; k++) {
      const o = k * 6 + 2;
      ctx.moveTo(SPIKE_PATH[o] * 0.74, SPIKE_PATH[o + 1] * 0.74);
      ctx.lineTo(SPIKE_PATH[o], SPIKE_PATH[o + 1]);
    }
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.7 + 0.3 * hot;
    ctx.lineWidth = lw * 1.4;
    ctx.stroke();

    // The core keeps its light top left whatever the spin: drawn unrotated.
    ctx.rotate(-spin);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = this._fills.chipperCore;
    ctx.beginPath();
    ctx.arc(0, 0, CHIPPER_CORE, 0, TAU);
    ctx.fill();
    // A glowing seam that tumbles as it spins.
    ctx.rotate(spin);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = COLORS.chipper;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = lw * 1.5;
    ctx.beginPath();
    ctx.ellipse(0, 0, CHIPPER_CORE * 0.86, CHIPPER_CORE * (0.18 + 0.22 * Math.abs(Math.sin((foe.phase || 0) * 2.2))), 0, 0, TAU);
    ctx.stroke();
    ctx.restore();

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(px - r * 0.24, py - r * 0.27, r * 0.15, r * 0.07, -0.75, 0, TAU);
    ctx.fill();
    if (hot > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = hot;
      const flash = r * 1.25;
      ctx.drawImage(glowSprite('#ffffff'), px - flash, py - flash, flash * 2, flash * 2);
    }
  }

  // ── Seeker: a cartoon bullet ─────────────────────────────────────────────

  _drawSeeker(ctx, cs, px, py, foe, state) {
    const r = foe.radius * cs;
    const lock = state.lock;
    const boost = clamp01(foe.boost || 0);
    const heading = foe.heading || 0;

    // Radar: a faint ring sweeping out on the seeker's own clock, quicker and brighter once it has locked on.
    ctx.globalCompositeOperation = 'lighter';
    const disc = r * (2.6 + 0.8 * lock);
    ctx.globalAlpha = 0.14 + 0.2 * lock;
    ctx.drawImage(glowSprite(COLORS.seeker, 'soft'), px - disc, py - disc, disc * 2, disc * 2);
    ctx.strokeStyle = COLORS.seeker;
    ctx.lineWidth = Math.max(1, cs * (0.06 + 0.05 * lock));
    for (let k = 0; k < 2; k++) {
      const weight = k ? lock : 1; // the second ring only joins once it hunts
      if (weight < 0.02) continue;
      const p = (state.radar + k * 0.5) % 1;
      ctx.globalAlpha = weight * (0.22 + 0.36 * lock) * (1 - p) ** 1.4;
      ctx.beginPath();
      ctx.arc(px, py, r * 1.1 + cs * (2.4 - 0.4 * lock) * easeOutCubic(p), 0, TAU);
      ctx.stroke();
    }

    // Light comes from the top left: facing left, the bullet is mirrored so its highlight stays on top.
    const flip = Math.cos(heading) < 0 ? -1 : 1;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(heading);
    ctx.scale(r, r * flip);

    // Exhaust: a pilot flame while it cruises, a long flickering jet at full chase.
    const jet = (0.4 + 1.5 * boost) * (0.82 + 0.36 * hash(Math.floor((foe.phase || 0) * 30) + state.seed));
    ctx.beginPath();
    ctx.moveTo(TAIL, -0.32);
    ctx.quadraticCurveTo(TAIL - jet * 0.55, -0.26, TAIL - jet, 0);
    ctx.quadraticCurveTo(TAIL - jet * 0.55, 0.26, TAIL, 0.32);
    ctx.closePath();
    ctx.fillStyle = COLORS.seekerBurst[2];
    ctx.globalAlpha = 0.45 + 0.35 * boost;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(TAIL, -0.15);
    ctx.quadraticCurveTo(TAIL - jet * 0.35, -0.1, TAIL - jet * 0.62, 0);
    ctx.quadraticCurveTo(TAIL - jet * 0.35, 0.1, TAIL, 0.15);
    ctx.closePath();
    ctx.fillStyle = COLORS.seekerBurst[1];
    ctx.globalAlpha = 0.85;
    ctx.fill();
    const g = 0.45 + 0.7 * boost;
    ctx.globalAlpha = 0.3 + 0.5 * boost;
    ctx.drawImage(glowSprite(COLORS.seeker), TAIL - jet * 0.4 - g, -g, g * 2, g * 2);

    // Fins, then the hull; each laid over a dark rim that lifts it off bright ice.
    const lw = Math.max(1, cs * 0.05) / r;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.strokeStyle = SEEKER_RIM;
    ctx.lineWidth = lw * 2.5;
    ctx.beginPath();
    ctx.moveTo(-0.3, -BODY + 0.02);
    ctx.lineTo(-0.98, -0.95);
    ctx.lineTo(-0.86, -0.4);
    ctx.closePath();
    ctx.moveTo(-0.3, BODY - 0.02);
    ctx.lineTo(-0.98, 0.95);
    ctx.lineTo(-0.86, 0.4);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = SEEKER_FIN;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(TAIL, -BODY);
    ctx.lineTo(0.3, -BODY);
    ctx.bezierCurveTo(0.78, -BODY, NOSE, -0.26, NOSE, 0);
    ctx.bezierCurveTo(NOSE, 0.26, 0.78, BODY, 0.3, BODY);
    ctx.lineTo(TAIL, BODY);
    ctx.quadraticCurveTo(TAIL - 0.12, 0, TAIL, -BODY);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = this._fills.bullet;
    ctx.fill();
    ctx.fillStyle = SEEKER_BAND;
    ctx.fillRect(-0.5, -BODY, 0.17, BODY * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    ctx.moveTo(-0.62, -0.33);
    ctx.lineTo(0.5, -0.33);
    ctx.stroke();

    // A dark visor with a pupil that lights up when it has you.
    ctx.globalAlpha = 1;
    ctx.fillStyle = SEEKER_VISOR;
    ctx.beginPath();
    ctx.ellipse(0.66, -0.12, 0.17, 0.13, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = COLORS.seeker;
    ctx.beginPath();
    ctx.arc(0.7, -0.12, 0.07, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    const eye = 0.22 + 0.3 * lock;
    ctx.globalAlpha = 0.35 + 0.65 * lock;
    ctx.drawImage(glowSprite(COLORS.seeker), 0.7 - eye, -0.12 - eye, eye * 2, eye * 2);
    ctx.restore();
  }

  // ── Spawner: a holed sphere ──────────────────────────────────────────────

  _drawSpawner(ctx, cs, px, py, foe, state) {
    const t = foe.phase || 0;
    const spin = foe.spin || 0;
    const ports = Math.max(1, foe.ports | 0);
    const next = foe.nextPort;
    const charge = clamp01(foe.charge || 0);
    const ready = charge >= 0.85 ? 0.5 + 0.5 * Math.sin(t * 18) : 0; // charged, waiting to fire: it throbs
    const launch = state.launch < LAUNCH_LIFE ? 1 - state.launch / LAUNCH_LIFE : 0; // 1 → 0 after a launch
    const r = foe.radius * cs * (1 - 0.06 * Math.sin(Math.PI * launch)); // the shell recoils, then settles

    ctx.globalCompositeOperation = 'lighter';
    const halo = foe.radius * cs * (2 + 0.08 * Math.sin(t * 2.4));
    ctx.globalAlpha = 0.36 + 0.2 * charge * charge;
    ctx.drawImage(glowSprite(COLORS.spawner), px - halo, py - halo, halo * 2, halo * 2);

    ctx.save();
    ctx.translate(px, py);
    ctx.scale(r, r);
    const lw = Math.max(1, cs * 0.06) / r;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = this._fills.shell;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, TAU);
    ctx.fill();

    // The central vent breathes slowly.
    ctx.fillStyle = PORT_LIP;
    ctx.beginPath();
    ctx.arc(0, 0, 0.17, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.45 + 0.2 * Math.sin(t * 3);
    ctx.drawImage(glowSprite(COLORS.spawnerBurst[1]), -0.3, -0.3, 0.6, 0.6);

    for (let k = 0; k < ports; k++) {
      const a = spin + (k * TAU) / ports;
      const hx = Math.cos(a) * PORT_RING;
      const hy = Math.sin(a) * PORT_RING;
      ctx.save();
      ctx.translate(hx, hy);
      ctx.rotate(a);
      ctx.scale(PORT_TILT, 1);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = PORT_LIP;
      ctx.beginPath();
      ctx.arc(0, 0, PORT_HOLE * 1.25, 0, TAU);
      ctx.fill();
      ctx.fillStyle = this._fills.port;
      ctx.beginPath();
      ctx.arc(0, 0, PORT_HOLE, 0, TAU);
      ctx.fill();
      ctx.restore();
      let heat = 0.3;
      if (k === next) heat += 0.7 * charge * charge + 0.4 * ready;
      if (k === state.port) heat += 1.3 * launch;
      const glow = PORT_HOLE * (1.5 + 1.2 * Math.min(1.5, heat));
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, heat);
      ctx.drawImage(glowSprite(k === next ? COLORS.qix : COLORS.spawner), hx - glow, hy - glow, glow * 2, glow * 2);
    }

    // The next port's charge closes round it like a dial.
    if (charge > 0.02 && next >= 0 && next < ports) {
      const a = spin + (next * TAU) / ports;
      ctx.strokeStyle = COLORS.qixBurst[1];
      ctx.globalAlpha = 0.5 + 0.5 * ready;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * PORT_RING, Math.sin(a) * PORT_RING, PORT_HOLE * 1.6, a - Math.PI * charge, a + Math.PI * charge);
      ctx.stroke();
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = COLORS.spawnerBurst[1];
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(0, 0, 1 - lw / 2, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(-0.42, -0.5, 0.22, 0.09, -0.7, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

/** Unit-space gradients (radius 1 = the body), made once and placed with translate / scale at draw time. */
function makeFills(ctx) {
  const orb = ctx.createRadialGradient(-0.18, -0.22, 0, 0, 0, 1);
  orb.addColorStop(0, '#ffffff');
  orb.addColorStop(0.16, '#ffc8f2');
  orb.addColorStop(0.44, COLORS.qix);
  orb.addColorStop(0.8, COLORS.qixBurst[3]);
  orb.addColorStop(1, '#4c1d95');

  const spikes = ctx.createRadialGradient(0, 0, SPIKE_BASE * 0.9, 0, 0, 1);
  spikes.addColorStop(0, '#8f1430');
  spikes.addColorStop(0.45, COLORS.chipper);
  spikes.addColorStop(0.85, COLORS.chipperBurst[1]);
  spikes.addColorStop(1, '#ffffff');

  const chipperCore = ctx.createRadialGradient(-0.2, -0.24, 0.02, 0, 0, CHIPPER_CORE);
  chipperCore.addColorStop(0, '#ff8a6a');
  chipperCore.addColorStop(0.35, COLORS.chipperBurst[3]);
  chipperCore.addColorStop(0.75, '#6e0a22');
  chipperCore.addColorStop(1, '#3a0412');

  const bullet = ctx.createLinearGradient(0, -BODY, 0, BODY);
  bullet.addColorStop(0, '#f4fff8');
  bullet.addColorStop(0.35, '#c9f9dc');
  bullet.addColorStop(0.75, '#7fe0a6');
  bullet.addColorStop(1, '#46b878');

  const shell = ctx.createRadialGradient(-0.35, -0.4, 0.05, 0, 0, 1);
  shell.addColorStop(0, '#9a72e0');
  shell.addColorStop(0.3, '#4a2588');
  shell.addColorStop(0.75, '#1f0b40');
  shell.addColorStop(1, '#0e0424');

  const port = ctx.createRadialGradient(0, 0, 0, 0, 0, PORT_HOLE);
  port.addColorStop(0, '#ffe0f8');
  port.addColorStop(0.3, COLORS.qix);
  port.addColorStop(0.7, COLORS.spawner);
  port.addColorStop(1, '#2c0b5a');

  return { orb, spikes, chipperCore, bullet, shell, port };
}
