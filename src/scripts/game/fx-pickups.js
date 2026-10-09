import { COLORS, TUNING } from '../config.js';
import { POWER_BURSTS } from './fx-powers.js';
import { TAU, clamp01, easeOutBack, easeOutCubic, glowSprite } from './fx-util.js';

const POP_IN = 0.38; // seconds of the pick-up's own age it takes to pop in, so a pause holds it mid-pop
const BLINK = 3; // seconds: it blinks through the last of its life …
const BLINK_FROM = 2; // … at this many blinks per second, quickening by …
const BLINK_GAIN = 1.3; // … this many per second per second
const GHOST_LIFE = 0.3;
const MIN_RADIUS = 8; // CSS px: any smaller and the glyph stops reading on a phone-sized board
const DISC_EDGE = 'rgba(4, 10, 28, 0.94)';
const NONE = [];

/**
 * The pick-ups waiting in the field: a floating glass badge with the power's glyph, bobbing and pulsing on the
 * pick-up's own clock, blinking as it runs out. Also the after-glow of a badge that was just taken or expired.
 */
export class Pickups {
  constructor(effects, { lowPower = false } = {}) {
    this.effects = effects;
    this.lowPower = lowPower;
    this._ramps = {};
    for (const type of Object.keys(POWER_BURSTS)) {
      this._ramps[type] = effects.particles.ramp(POWER_BURSTS[type]);
      glowSprite(COLORS.powers[type]);
    }
    this._disc = null;
    this._ghosts = [];
  }

  reset() {
    this._ghosts.length = 0;
  }

  // ── Moments ──────────────────────────────────────────────────────────────

  /** Motes of its colour gather on the spot as the badge pops in. */
  spawned(pickup) {
    const p = this.effects.particles;
    const ramp = this._ramp(pickup.type);
    const n = this.lowPower ? 10 : 20;
    for (let j = 0; j < n; j++) {
      const a = Math.random() * TAU;
      const d = 1.3 + Math.random() * 0.9;
      const life = 0.28 + Math.random() * 0.14;
      p.spawn(pickup.x + Math.cos(a) * d, pickup.y + Math.sin(a) * d, (-Math.cos(a) * d) / life, (-Math.sin(a) * d) / life, life, 0.08 + Math.random() * 0.06, 0, 0, ramp, false);
    }
  }

  /** The badge swells and fades as its colour bursts out. */
  collected(pickup) {
    this._ghost(pickup, true);
    const p = this.effects.particles;
    const ramp = this._ramp(pickup.type);
    const n = this.lowPower ? 18 : 36;
    for (let j = 0; j < n; j++) {
      const a = (j / n) * TAU + Math.random() * 0.2;
      const v = 6 + Math.random() * 5;
      p.spawn(pickup.x + Math.cos(a) * 0.6, pickup.y + Math.sin(a) * 0.6, Math.cos(a) * v, Math.sin(a) * v, 0.35 + Math.random() * 0.25, 0.1 + Math.random() * 0.06, 3, 0, ramp, j % 6 === 0);
    }
  }

  /** The badge folds in on itself and leaves a few motes behind. */
  expired(pickup) {
    this._ghost(pickup, false);
    const p = this.effects.particles;
    const ramp = this._ramp(pickup.type);
    const n = this.lowPower ? 6 : 12;
    for (let j = 0; j < n; j++) {
      const a = Math.random() * TAU;
      const v = 0.5 + Math.random() * 2;
      p.spawn(pickup.x + Math.cos(a) * 0.5, pickup.y + Math.sin(a) * 0.5, Math.cos(a) * v, Math.sin(a) * v - 1, 0.4 + Math.random() * 0.4, 0.07 + Math.random() * 0.05, 1.5, 0, ramp, false);
    }
  }

  _ghost(pickup, grow) {
    const age = pickup.age || 0;
    this._ghosts.push({ type: pickup.type, x: pickup.x, y: pickup.y + bob(age), scale: popScale(age), age, grow, t: 0 });
  }

  _ramp(type) {
    return this._ramps[type] ?? this._ramps.life;
  }

  // ── Per-frame ────────────────────────────────────────────────────────────

  update(dt) {
    const ghosts = this._ghosts;
    for (let i = ghosts.length - 1; i >= 0; i--) {
      ghosts[i].t += dt;
      if (ghosts[i].t >= GHOST_LIFE) ghosts.splice(i, 1);
    }
  }

  /** view = the Renderer; ctx is in CSS pixels with the shake already applied. */
  draw(ctx, view, pickups = NONE) {
    if (!pickups.length && !this._ghosts.length) return;
    if (!this._disc) {
      const disc = ctx.createRadialGradient(-0.3, -0.35, 0, 0, 0, 1);
      disc.addColorStop(0, 'rgba(26, 56, 112, 0.94)');
      disc.addColorStop(0.7, 'rgba(8, 22, 58, 0.94)');
      disc.addColorStop(1, DISC_EDGE);
      this._disc = disc;
    }
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    const base = Math.max(MIN_RADIUS, TUNING.pickupRadius * cs);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const pickup of pickups) {
      if (pickup.alive === false) continue;
      const age = pickup.age || 0;
      const r = base * popScale(age);
      if (r < 0.5) continue;
      this._drawBadge(ctx, ox + pickup.x * cs, oy + (pickup.y + bob(age)) * cs, pickup.type, r, blink(age, pickup.life), age);
    }

    for (const ghost of this._ghosts) {
      const p = ghost.t / GHOST_LIFE;
      const grow = ghost.grow ? 1 + 0.7 * easeOutCubic(p) : 1 - p * p;
      const alpha = ghost.grow ? (1 - p) ** 2 : 1 - p;
      // A badge taken on the very frame it appeared has not popped in yet: nothing to fade out.
      const r = base * ghost.scale * grow;
      if (r < 0.5) continue;
      this._drawBadge(ctx, ox + ghost.x * cs, oy + ghost.y * cs, ghost.type, r, alpha, ghost.age);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _drawBadge(ctx, px, py, type, r, alpha, age) {
    const color = COLORS.powers[type] || '#ffffff';
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (0.38 + 0.12 * Math.sin(age * 4.2)) * alpha;
    const halo = r * 2.3;
    ctx.drawImage(glowSprite(color), px - halo, py - halo, halo * 2, halo * 2);

    ctx.save();
    ctx.translate(px, py);
    ctx.scale(r, r);
    const lw = 1 / r; // one CSS pixel in unit space
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this._disc;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55 * alpha;
    ctx.lineWidth = Math.max(lw, 0.05);
    ctx.beginPath();
    ctx.arc(0, 0, 0.77, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = COLORS.ice[0];
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(lw * 1.5, 0.12);
    ctx.beginPath();
    ctx.arc(0, 0, 0.93, 0, TAU);
    ctx.stroke();

    drawGlyph(ctx, type, color, lw, alpha);

    // Glass: a glint top left and a mote circling the rim.
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.5 * alpha;
    ctx.lineWidth = Math.max(lw, 0.07);
    ctx.beginPath();
    ctx.arc(0, 0, 0.8, Math.PI * 1.1, Math.PI * 1.42);
    ctx.stroke();
    const a = age * 2.2;
    ctx.globalAlpha = alpha;
    ctx.drawImage(glowSprite(color), Math.cos(a) * 0.93 - 0.3, Math.sin(a) * 0.93 - 0.3, 0.6, 0.6);
    ctx.restore();
  }
}

/** Pop-in, then a gentle pulse. */
function popScale(age) {
  return easeOutBack(clamp01(age / POP_IN), 2.2) * (1 + 0.05 * Math.sin(age * 4.2));
}

/** Vertical float, cells. */
function bob(age) {
  return Math.sin(age * 2.6) * 0.12;
}

/**
 * 1, or an on / off blink through the last BLINK seconds. The blink rate climbs linearly, so its phase
 * is the integral of that rate: the blinks quicken smoothly instead of stuttering.
 */
function blink(age, life) {
  if (!(life > 0)) return 1;
  const into = age - (life - BLINK);
  if (into <= 0) return 1;
  const phase = BLINK_FROM * into + (BLINK_GAIN * into * into) / 2;
  return phase % 1 < 0.62 ? 1 : 0.22;
}

/**
 * A power's glyph in unit space (badge radius 1): a coloured neon stroke under a thin white core, with a
 * translucent fill where the shape has a body. `lw` is one CSS pixel in unit space.
 */
function drawGlyph(ctx, type, color, lw, alpha) {
  ctx.fillStyle = color;
  ctx.globalCompositeOperation = 'source-over';
  switch (type) {
    case 'speed':
      ctx.beginPath();
      ctx.moveTo(-0.46, -0.4);
      ctx.lineTo(-0.08, 0);
      ctx.lineTo(-0.46, 0.4);
      ctx.moveTo(0.02, -0.4);
      ctx.lineTo(0.4, 0);
      ctx.lineTo(0.02, 0.4);
      break;
    case 'freeze':
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k * TAU) / 6 - Math.PI / 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        ctx.moveTo(0, 0);
        ctx.lineTo(c * 0.56, s * 0.56);
        ctx.moveTo(c * 0.34 + Math.cos(a + 0.8) * 0.17, s * 0.34 + Math.sin(a + 0.8) * 0.17);
        ctx.lineTo(c * 0.34, s * 0.34);
        ctx.lineTo(c * 0.34 + Math.cos(a - 0.8) * 0.17, s * 0.34 + Math.sin(a - 0.8) * 0.17);
      }
      break;
    case 'slow':
      // Sand: most of it already run through.
      ctx.globalAlpha = 0.75 * alpha;
      ctx.beginPath();
      ctx.moveTo(-0.2, 0.45);
      ctx.lineTo(0.2, 0.45);
      ctx.lineTo(0, 0.17);
      ctx.closePath();
      ctx.moveTo(-0.09, -0.28);
      ctx.lineTo(0.09, -0.28);
      ctx.lineTo(0, -0.14);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-0.27, -0.48);
      ctx.lineTo(0.27, -0.48);
      ctx.lineTo(0.04, 0);
      ctx.lineTo(0.27, 0.48);
      ctx.lineTo(-0.27, 0.48);
      ctx.lineTo(-0.04, 0);
      ctx.closePath();
      ctx.moveTo(-0.38, -0.52);
      ctx.lineTo(0.38, -0.52);
      ctx.moveTo(-0.38, 0.52);
      ctx.lineTo(0.38, 0.52);
      break;
    case 'shield':
      ctx.beginPath();
      ctx.moveTo(-0.42, -0.46);
      ctx.lineTo(0.42, -0.46);
      ctx.lineTo(0.42, -0.04);
      ctx.quadraticCurveTo(0.4, 0.36, 0, 0.56);
      ctx.quadraticCurveTo(-0.4, 0.36, -0.42, -0.04);
      ctx.closePath();
      ctx.globalAlpha = 0.32 * alpha;
      ctx.fill();
      ctx.moveTo(0, -0.3);
      ctx.lineTo(0, 0.34);
      break;
    case 'cut':
      // Open scissors: blades to the right, finger loops to the left.
      ctx.beginPath();
      ctx.moveTo(-0.25, 0.12);
      ctx.lineTo(0.5, -0.24);
      ctx.moveTo(-0.25, -0.12);
      ctx.lineTo(0.5, 0.24);
      ctx.moveTo(-0.21, 0.24);
      ctx.arc(-0.36, 0.24, 0.15, 0, TAU);
      ctx.moveTo(-0.21, -0.24);
      ctx.arc(-0.36, -0.24, 0.15, 0, TAU);
      break;
    default: {
      // Extra life: the player's arrowhead, nose up, with a small "+".
      ctx.beginPath();
      ctx.moveTo(-0.1, -0.4);
      ctx.lineTo(-0.41, 0.39);
      ctx.lineTo(-0.1, 0.21);
      ctx.lineTo(0.21, 0.39);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.9 * alpha;
      ctx.fill();
      ctx.moveTo(0.22, -0.3);
      ctx.lineTo(0.5, -0.3);
      ctx.moveTo(0.36, -0.44);
      ctx.lineTo(0.36, -0.16);
    }
  }
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = Math.max(lw * 2, 0.17);
  ctx.stroke();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = '#ffffff';
  ctx.globalAlpha = 0.85 * alpha;
  ctx.lineWidth = Math.max(lw, 0.06);
  ctx.stroke();
}
