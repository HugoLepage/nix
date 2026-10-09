import { COLORS, TUNING } from '../config.js';
import { TAU, approach, glowSprite } from './fx-util.js';

const RISE = 14; // 1 / s: a power's look snaps in …
const FALL = 5; // … and lets go a little more gently
const SHIELD_WARN = 2; // s: the shield flickers through its last seconds …
const BOOST_WARN = 1.2; // … and so does the afterburner
const FROST = COLORS.powers.freeze;
const SAND = COLORS.powers.slow;
const NO_DASH = [];
const NO_POWERS = Object.freeze({ speed: 0, freeze: 0, slow: 0, shield: 0, cut: false });

/** Names popped when a pick-up is collected: the same names as the field guide. */
export const POWER_LABELS = {
  speed: 'Boost',
  freeze: 'Time stop',
  slow: 'Slow-mo',
  shield: 'Shield',
  cut: 'Instant cut',
  life: 'Extra life',
};

/** Hot → cool burst colours per power. One list object each, so their particle ramps are found by identity. */
export const POWER_BURSTS = {
  speed: ['#ffffff', COLORS.powers.speed, '#ffb02e', '#ff7a1c'],
  freeze: ['#ffffff', COLORS.powers.freeze, COLORS.ice[1], COLORS.ice[3]],
  slow: ['#ffffff', COLORS.powers.slow, '#ff9a3c', '#c2410c'],
  shield: ['#ffffff', COLORS.powers.shield, COLORS.ice[2], COLORS.ice[3]],
  cut: ['#ffffff', COLORS.powers.cut, '#9be33a', '#3f8f1a'],
  life: ['#ffffff', COLORS.powers.life, COLORS.ice[1], COLORS.ice[2]],
};

/**
 * Eased 0..1 levels of the active powers, so every look fades in and out instead of popping, plus the
 * overlays that more than one module paints with them: the frost and sand shells over the enemies and
 * the frost vignette. Updated once per frame, before anything that reads it.
 */
export class PowerLook {
  constructor({ lowPower = false } = {}) {
    this.lowPower = lowPower;
    this._shellFill = null;
    this._vignette = null;
    this._vignetteW = 0;
    this._vignetteH = 0;
    this._dash = [0, 0];
    this.reset();
  }

  /** New level: every look off at once. */
  reset() {
    this.powers = NO_POWERS;
    this.time = 0;
    this.frost = 0;
    this.sand = 0;
    this.boost = 0;
    this.shield = 0;
    this.cut = 0;
    this.shieldAge = 1; // seconds since the shield last went up: drives the bubble's pop-in
    this.grace = 0; // seconds left of the immunity that follows a broken shield
    this.froze = false; // true for the one frame in which a time stop took hold
    this.shieldFlicker = 1; // 1 while the shield is steady; a quickening on / off through its last seconds
    this.boostFlicker = 1; // the same for the afterburner
    this._frozen = false;
    this._shieldBlink = 0;
    this._boostBlink = 0;
  }

  update(scene, dt) {
    // A won level's powers no longer count (the HUD hides them too): every look lets go.
    const won = scene.state === 'won';
    const powers = won ? NO_POWERS : scene.powers || NO_POWERS;
    this.powers = powers;
    const frozen = powers.freeze > 0;
    this.froze = frozen && !this._frozen;
    this._frozen = frozen;
    this.frost = ease(this.frost, frozen ? 1 : 0, dt);
    this.sand = ease(this.sand, powers.slow > 0 ? 1 : 0, dt);
    this.boost = ease(this.boost, powers.speed > 0 ? 1 : 0, dt);
    // A shield that runs out is gone at once, like a broken one: a fading bubble would promise cover that has
    // ended. Only on a won level, with nothing left to hit, does it fade with the rest.
    this.shield = powers.shield > 0 ? ease(this.shield, 1, dt) : won ? ease(this.shield, 0, dt) : 0;
    this.cut = ease(this.cut, powers.cut ? 1 : 0, dt);
    // Held once the timer is out, so a look that lets go fades from wherever its blink stood, never from full.
    if (powers.shield > 0) this.shieldFlicker = blink(this._shieldBlink, powers.shield, SHIELD_WARN);
    if (powers.speed > 0) this.boostFlicker = blink(this._boostBlink, powers.speed, BOOST_WARN);
    this.shieldAge += dt;
    // Warnings and the grace run on play time, like the timers they show: a pause holds them.
    if (scene.state === 'paused') return;
    this.time += dt;
    this._shieldBlink += dt * blinkRate(powers.shield, SHIELD_WARN);
    this._boostBlink += dt * blinkRate(powers.speed, BOOST_WARN);
    if (scene.state === 'playing') this.grace = Math.max(0, this.grace - dt);
  }

  /** A power took effect. Only the shield has an entrance of its own here: its bubble pops in. */
  started(type) {
    if (type === 'shield') this.shieldAge = 0;
  }

  /** The shield absorbed a hit: the bubble is gone at once, and the grace (ship and line immune) begins. */
  shieldBroke() {
    this.shield = 0;
    this.grace = TUNING.shieldGrace;
  }

  playerDied() {
    this.grace = 0;
  }

  /** Strength of the cyan sheath on the line: the shield itself, then the grace fading out behind it. */
  get sheath() {
    const grace = this.grace > 0 ? (this.grace / TUNING.shieldGrace) * (Math.sin(this.time * 38) > 0 ? 0.9 : 0.35) : 0;
    return Math.max(this.shield * this.shieldFlicker, grace);
  }

  // ── Enemy overlays ───────────────────────────────────────────────────────

  /** Frost, then sand, over an enemy drawn with radius `r` px at (px, py). `seed` turns its ice crystals. */
  shells(ctx, px, py, r, cs, seed) {
    if (this.frost > 0.01) this._frostShell(ctx, px, py, r, cs, seed);
    // A frozen enemy is not also slowed: the frost wins.
    const sand = this.sand * (1 - this.frost);
    if (sand > 0.01) this._sandShell(ctx, px, py, r, cs, sand);
  }

  /** An icy-white shell that reads as frozen solid: cold halo, frosted glass, crystals on the rim, a glint. */
  _frostShell(ctx, px, py, r, cs, seed) {
    const level = this.frost;
    if (!this._shellFill) {
      const fill = ctx.createRadialGradient(-0.3, -0.35, 0, 0, 0, 1.04);
      fill.addColorStop(0, 'rgba(240, 253, 255, 0.6)');
      fill.addColorStop(0.5, 'rgba(205, 242, 255, 0.42)');
      fill.addColorStop(0.86, 'rgba(190, 236, 255, 0.62)');
      fill.addColorStop(1, 'rgba(236, 252, 255, 0.92)');
      this._shellFill = fill;
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.32 * level;
    const halo = r * 1.75;
    ctx.drawImage(glowSprite(FROST), px - halo, py - halo, halo * 2, halo * 2);

    ctx.save();
    ctx.translate(px, py);
    ctx.scale(r, r);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = level;
    ctx.fillStyle = this._shellFill;
    ctx.beginPath();
    ctx.arc(0, 0, 1.04, 0, TAU);
    ctx.fill();
    const lw = Math.max(1, cs * 0.06) / r;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = seed + (k * TAU) / 6;
      const c = Math.cos(a);
      const s = Math.sin(a);
      ctx.moveTo(c * 0.9, s * 0.9);
      ctx.lineTo(c * 1.3, s * 1.3);
      ctx.moveTo(c * 1.12, s * 1.12);
      ctx.lineTo(c * 1.12 + Math.cos(a + 0.9) * 0.13, s * 1.12 + Math.sin(a + 0.9) * 0.13);
    }
    ctx.moveTo(1.04, 0);
    ctx.arc(0, 0, 1.04, 0, TAU);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.globalAlpha = 0.85 * level;
    ctx.lineWidth = lw * 1.8;
    ctx.beginPath();
    ctx.arc(0, 0, 0.74, Math.PI * 1.08, Math.PI * 1.42);
    ctx.stroke();
    ctx.restore();
  }

  /** A faint sand-amber wash and a slow ticking ring: subtle, the motion itself tells the rest. */
  _sandShell(ctx, px, py, r, cs, level) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.22 * level;
    ctx.fillStyle = SAND;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, TAU);
    ctx.fill();
    const ring = r * 1.14;
    this._dash[0] = ring * 0.32;
    this._dash[1] = ring * 0.2;
    ctx.setLineDash(this._dash);
    ctx.lineDashOffset = -this.time * ring * 0.4;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5 * level;
    ctx.strokeStyle = SAND;
    ctx.lineWidth = Math.max(1, cs * 0.07);
    ctx.beginPath();
    ctx.arc(px, py, ring, 0, TAU);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
  }

  /** Faint frost creeping in from the screen edges while time stands still. view = the Renderer. */
  drawVignette(ctx, view) {
    const level = this.frost;
    if (level < 0.01 || this.lowPower) return;
    if (!this._vignette || this._vignetteW !== view.width || this._vignetteH !== view.height) {
      const cx = view.width / 2;
      const cy = view.height / 2;
      const reach = Math.hypot(cx, cy);
      const g = ctx.createRadialGradient(cx, cy, reach * 0.42, cx, cy, reach);
      g.addColorStop(0, 'rgba(200, 246, 255, 0)');
      g.addColorStop(0.62, 'rgba(200, 246, 255, 0.04)');
      g.addColorStop(1, 'rgba(225, 250, 255, 0.3)');
      this._vignette = g;
      this._vignetteW = view.width;
      this._vignetteH = view.height;
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = level;
    ctx.fillStyle = this._vignette;
    // Oversized so the shake translation never uncovers an edge.
    ctx.fillRect(-64, -64, view.width + 128, view.height + 128);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

function ease(value, target, dt) {
  const next = approach(value, target, target > value ? RISE : FALL, dt);
  return Math.abs(target - next) < 0.002 ? target : next;
}

/** Blinks per second while a timer runs out: 3 at the start of the warning, 10 at the very end. */
function blinkRate(left, span) {
  return left > 0 && left < span ? 3 + 7 * (1 - left / span) : 0;
}

/** `phase` is accumulated from blinkRate(), so the rate can climb without the blink stuttering. `left` > 0. */
function blink(phase, left, span) {
  if (left >= span) return 1;
  return phase % 1 < 0.7 ? 1 : 0.2;
}
