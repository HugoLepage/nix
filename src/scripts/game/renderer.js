/**
 * NIX renderer — Canvas 2D, device-pixel aware (DPR capped at 2).
 *
 * PUBLIC API (all coordinates are BOARD space — cells — unless noted)
 *
 *   new Renderer(canvas, { lowPower = false, insets } = {})
 *       insets = CSS px kept free around the board for the HUD / progress bar.
 *       Default { top: 56, right: 10, bottom: 46, left: 10 }.
 *   setInsets({ top, right, bottom, left })   partial updates allowed; re-fits the board
 *   playArea → { width, height }   CSS px left for the board. Feed THIS to computeGridSize()
 *                                  so the grid's shape matches the space it is drawn in.
 *   setGrid(grid)      new level: drops every running effect and tracked entity, rebuilds all layers
 *   resize()           re-reads the canvas CSS box + devicePixelRatio, re-bakes if either changed; safe at any time
 *   measure()          the same re-read without the re-bake (a setGrid() follows); returns whether anything changed
 *   render(scene, dt)  draws one frame and ADVANCES ALL VISUAL TIME, effects included — do not
 *                      call effects.update() yourself. `dt` must be the REAL frame time in
 *                      seconds (not multiplied by effects.timeScale), in every game state.
 *       scene = { grid, player, sparx: [], foes: [], pickups: [], powers, time, state }
 *         foes     every free-flying enemy; drawn by `kind` ('qix' | 'chipper' | 'seeker' | 'spawner') at
 *                  `radius`, so the body drawn is the hit circle. Read: kind, x, y, vx, vy, heading, radius,
 *                  phase (the foe's own clock: freeze / slow show by it standing still / crawling), alive;
 *                  seeker locked, boost; spawner spin, ports, charge, nextPort; chipper spin.
 *         pickups  field items { type, x, y, age, life, alive }: bob, pulse, blink for the last 3 s of `life`.
 *         powers   { speed, freeze, slow, shield, cut } seconds left (cut: boolean). Optional: absent = none.
 *       Entities are read through their documented fields only; `alive === false` hides one.
 *   cellSize, offsetX, offsetY   board → CSS px:  sx = offsetX + (x + 0.5) * cellSize
 *   effects            Effects instance. The game multiplies its SIMULATION dt by effects.timeScale
 *                      (0 during a hit-stop, else 1). Primitives, should the game want extras:
 *                      explode, sparks, shockwave, flare, scorch, flash, shake, popup, hitStop,
 *                      schedule(delay, fn), clear — see effects.js.
 *
 *   Moments — call once when the thing happens; each one triggers its whole sequence
 *   (hit-stop, particles, rings, flash, shake, popup):
 *     onCapture(result)              grid.capture() result: fill wave, sparkles, shine, +N% popup
 *     onTrailCleared(cells)          grid.clearTrail() result: after-image + sparks along the line
 *     onPlayerSpawn(player)          materialise rings + sparks; call on every (re)spawn and relocation
 *     onPlayerDeath(x, y)            ~90 ms hit-stop, then the big explosion
 *     onFoeDestroyed(foe)            any kind: its own shatter, then a bloom in its colours, sized by radius
 *     onFoeLaunched(spawner, qix)    spawner fired `qix` from port `spawner.nextPort` (before it advances)
 *     onChipperImpact(x, y, regionId, hits)
 *                                    contact point; regionId 0 = the outer frame (sparks only), else
 *                                    hits = 1..chipperHits on that region: it cracks a little more each time
 *     onRegionShattered(result)      grid.revertRegion() result: the region's ice and cracks go, shards fall,
 *                                    -N% popup
 *     onPickupSpawned(pickup)        badge pops in
 *     onPickupCollected(pickup)      burst + the power's name
 *     onPickupExpired(pickup)        badge folds away
 *     onPowerStart(type, player)     a power took effect (also 'life' and arming 'cut')
 *     onShieldBreak(x, y)            the shield absorbed a hit at (x, y): the bubble bursts
 *     onInstantCut(cells)            the auto-drawn cells, player outward, BEFORE onCapture: a lime slash
 *     onSparxBurst(x, y)             amber burst (win sequence)
 *     onWin(grid, origin?)           floods the remaining open cells + particle fountain. Visual
 *                                    only: the grid is never mutated. `origin` defaults to the
 *                                    player's last position. Burst the enemies separately with
 *                                    onSparxBurst / onFoeDestroyed and mark them alive = false.
 *
 *   The rail re-bakes itself whenever grid.version changes; nothing to call for that.
 *   Internals: fx-board.js (baked layers, fill waves, sheen, region erase), fx-actors.js (trail, player,
 *   sparx), fx-foes.js (enemies), fx-pickups.js (pick-up badges), fx-damage.js (cracks, shards),
 *   fx-powers.js (eased power looks and their overlays), fx-util.js (colour / sprite / easing helpers).
 */
import { COLORS, TUNING } from '../config.js';
import { Effects } from './effects.js';
import { Actors } from './fx-actors.js';
import { BG_MARGIN, BoardLayers } from './fx-board.js';
import { Damage } from './fx-damage.js';
import { Foes } from './fx-foes.js';
import { Pickups } from './fx-pickups.js';
import { POWER_BURSTS, POWER_LABELS, PowerLook } from './fx-powers.js';
import { TAU, clamp01 } from './fx-util.js';

const MAX_DPR = 2;
const MAX_FRAME = 0.1; // seconds; a stalled tab must not fast-forward the animations
const DEFAULT_INSETS = { top: 56, right: 10, bottom: 46, left: 10 };
const DEATH_HIT_STOP = 0.09;
const FOE_HIT_STOP = 0.07;
const SHIELD_HIT_STOP = 0.05;
const SHATTER_HIT_STOP = 0.06;
const FOUNTAIN_BURSTS = 32;
const POPUP_FLOOR = 3.1; // cells: a popup rises 2.6, so starting this far down keeps it clear of the top rail and HUD
const SEAL_COLORS = ['#ffffff', COLORS.ice[0], COLORS.ice[1], COLORS.ice[3]];
// Gold, not ice: by the time the fountain plays the whole board is light blue, and only a warm hue reads on it.
// Blended flat (additive: false), since gold added onto light-blue ice saturates to white.
const FOUNTAIN_COLORS = ['#fff3c4', '#ffd166', COLORS.sparx, '#ff9f1c'];
const CORE_COLORS = ['#ffffff', '#ffffff', COLORS.ice[0], COLORS.ice[2]];
const SHATTER_COLORS = ['#ffffff', COLORS.ice[0], COLORS.chipperBurst[1], COLORS.chipper];
const foeLook = (color, burst) => ({ color, burst, core: ['#ffffff', '#ffffff', burst[1], burst[3]] });
/** Per enemy kind: its colour, its burst and the white-hot core of that burst. */
const FOE_LOOKS = {
  qix: foeLook(COLORS.qix, COLORS.qixBurst),
  chipper: foeLook(COLORS.chipper, COLORS.chipperBurst),
  seeker: foeLook(COLORS.seeker, COLORS.seekerBurst),
  spawner: foeLook(COLORS.spawner, COLORS.spawnerBurst),
};
const NONE = [];

const floorPercent = (fraction) => Math.floor(fraction * 100 + 1e-9);

export class Renderer {
  constructor(canvas, { lowPower = false, insets } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.lowPower = lowPower;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.effects = new Effects({ lowPower, reducedMotion });
    this.grid = null;
    this.time = 0;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.cellSize = 0;
    this.cellPx = 0;
    this.offsetX = 0;
    this.offsetY = 0;
    this.shiftX = 0; // current shake, CSS px
    this.shiftY = 0;
    this._insets = { ...DEFAULT_INSETS, ...insets };
    this._registerRamps();
    this._look = new PowerLook({ lowPower });
    this._board = new BoardLayers(this.effects, { lowPower });
    this._actors = new Actors(this.effects, this._look, { lowPower });
    this._foes = new Foes(this.effects, this._look, { lowPower });
    this._pickups = new Pickups(this.effects, { lowPower });
    this._damage = new Damage({ lowPower });
    this.resize();
  }

  /** Every colour list the moments below burst with, registered once in a fixed order (see Particles.ramp). */
  _registerRamps() {
    const p = this.effects.particles;
    for (const colors of [COLORS.playerBurst, CORE_COLORS, SEAL_COLORS, COLORS.sparxBurst, SHATTER_COLORS]) p.ramp(colors);
    for (const look of Object.values(FOE_LOOKS)) {
      p.ramp(look.burst);
      p.ramp(look.core);
    }
    for (const colors of Object.values(POWER_BURSTS)) p.ramp(colors);
    p.ramp(FOUNTAIN_COLORS, { additive: false });
  }

  get playArea() {
    const { top, right, bottom, left } = this._insets;
    return { width: Math.max(1, this.width - left - right), height: Math.max(1, this.height - top - bottom) };
  }

  setInsets(insets) {
    Object.assign(this._insets, insets);
    this._fit();
  }

  setGrid(grid) {
    this.grid = grid;
    this.effects.clear();
    this._look.reset();
    this._actors.reset();
    this._foes.reset();
    this._pickups.reset();
    this._damage.reset();
    this._board.setGrid(grid);
    this._fit();
  }

  /** Re-bakes only when the box or the pixel ratio really changed: a full bake costs tens to hundreds of ms. */
  resize() {
    if (this.measure()) this._fit();
  }

  /** Re-reads the canvas CSS box and devicePixelRatio and sizes the backing store, without re-baking. Returns whether anything changed. */
  measure() {
    const { canvas } = this;
    const style = getComputedStyle(canvas);
    const width = canvas.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = canvas.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    // A hidden canvas has no box: keep the last good layout until it is shown again.
    if (!(width > 0 && height > 0)) return false;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    if (width === this.width && height === this.height && dpr === this.dpr) return false;
    this.dpr = dpr;
    this.width = width;
    this.height = height;
    const pxW = Math.round(width * dpr);
    const pxH = Math.round(height * dpr);
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;
    return true;
  }

  /** Largest whole-device-pixel cell that fits, board centred in the play area and snapped to the pixel grid. */
  _fit() {
    const { grid, dpr } = this;
    if (!grid || !this.width) return;
    const area = this.playArea;
    this.cellPx = Math.max(2, Math.floor(Math.min((area.width * dpr) / grid.cols, (area.height * dpr) / grid.rows)));
    this.cellSize = this.cellPx / dpr;
    const snap = (v) => Math.round(v * dpr) / dpr;
    this.offsetX = snap(this._insets.left + (area.width - grid.cols * this.cellSize) / 2);
    this.offsetY = snap(this._insets.top + (area.height - grid.rows * this.cellSize) / 2);
    this._board.layout(this);
  }

  // ── Moments ──────────────────────────────────────────────────────────────

  onCapture(result) {
    if (!result) return;
    const fx = this.effects;
    const share = result.fractionAfter - result.fractionBefore;
    const seal = result.trailCells[result.trailCells.length - 1];
    this._board.startCapture(result);
    fx.shake(Math.min(0.7, 0.05 + share * 2.4));
    fx.sparks(seal.x, seal.y, { colors: SEAL_COLORS, count: 26, speed: 10 });
    fx.shockwave(seal.x, seal.y, { color: COLORS.ice[0], radius: 2.5 + Math.sqrt(result.gained) * 0.22, life: 0.45, width: 0.3 });
    const { centroid } = result;
    if (share > 0.04) fx.flash(COLORS.ice[0], Math.min(0.45, share * 2.2), 0.45, { ...centroid, radius: 10 + Math.sqrt(result.gained) });
    // The step of the HUD readout (hud.js setProgress floors the total), so the popup and the readout always agree.
    const percent = floorPercent(result.fractionAfter) - floorPercent(result.fractionBefore);
    if (percent >= 1) fx.popup(centroid.x, Math.max(centroid.y, POPUP_FLOOR), `+${percent}%`);
  }

  onTrailCleared(cells) {
    if (cells) this._actors.trailCleared(cells);
  }

  onPlayerSpawn(player) {
    this._actors.playerSpawned(player);
  }

  onPlayerDeath(x, y) {
    const fx = this.effects;
    this._actors.playerDied(x, y);
    this._look.playerDied();
    fx.hitStop(DEATH_HIT_STOP);
    fx.flash('#ffffff', 0.5, 0.14, { x, y, radius: 14 });
    fx.schedule(DEATH_HIT_STOP, () => {
      fx.explode(x, y, { colors: COLORS.playerBurst, count: 3400, speed: 40, life: 1.6, size: 0.21, glow: 0.07 });
      fx.explode(x, y, { colors: CORE_COLORS, count: 420, speed: 12, life: 0.6, size: 0.16, glow: 0.12 });
      fx.scorch(x, y, { radius: 9, life: 1.3, alpha: 0.7 });
      fx.flare(x, y, { color: '#ffffff', radius: 10, life: 0.45 });
      fx.shockwave(x, y, { color: '#ffffff', radius: 7, life: 0.38, width: 0.35 });
      fx.shockwave(x, y, { color: COLORS.ice[1], radius: 16, life: 0.85, width: 0.6, delay: 0.06 });
      fx.flash(COLORS.ice[2], 0.5, 0.45, { x, y, radius: 26 });
      fx.shake(1.1);
    });
  }

  /** Any enemy kind. A qix is the reference size; the rest scale by radius (a seeker's pop is half a qix's). */
  onFoeDestroyed(foe) {
    if (!foe) return;
    const fx = this.effects;
    const look = FOE_LOOKS[foe.kind] || FOE_LOOKS.qix;
    const { x, y } = foe;
    const scale = Math.max(0.5, Math.min(1.7, (foe.radius || TUNING.qixRadius) / TUNING.qixRadius));
    const mass = Math.min(1.25, scale); // particle counts: a spawner's bigger cloud must not drain the pool
    this._foes.destroyed(foe);
    fx.hitStop(FOE_HIT_STOP);
    fx.flare(x, y, { color: look.burst[1], radius: 6 * scale, life: 0.3 });
    fx.schedule(FOE_HIT_STOP, () => {
      // Lower speed and drag than the player's death: the cloud keeps unfolding for two seconds.
      fx.explode(x, y, { colors: look.burst, count: Math.round(4200 * mass), speed: 32 * scale, life: 2.4, size: 0.25, drag: 0.7, glow: 0.07 });
      fx.explode(x, y, { colors: look.core, count: Math.round(520 * mass), speed: 10, life: 0.8, size: 0.15, glow: 0.1 });
      // An enemy usually dies inside freshly captured ice: without the bruise its colour would wash out to white.
      fx.scorch(x, y, { radius: 15 * scale, life: 2.2, alpha: 0.85 });
      fx.flare(x, y, { color: look.burst[1], radius: 11 * scale, life: 0.6 });
      fx.shockwave(x, y, { color: look.burst[1], radius: 9 * scale, life: 0.5, width: 0.4 });
      fx.shockwave(x, y, { color: look.color, radius: 18 * scale, life: 1, width: 0.7, delay: 0.1 });
      fx.shockwave(x, y, { color: look.burst[3], radius: 27 * scale, life: 1.5, width: 0.9, delay: 0.24 });
      fx.flash(look.color, 0.6, 0.7, { x, y });
      fx.shake(1.3 * Math.min(1, 0.4 + 0.6 * scale));
    });
  }

  onFoeLaunched(spawner, qix) {
    if (!spawner) return;
    const fx = this.effects;
    const a = (spawner.spin || 0) + ((spawner.nextPort | 0) * TAU) / Math.max(1, spawner.ports | 0);
    const mx = spawner.x + Math.cos(a) * spawner.radius;
    const my = spawner.y + Math.sin(a) * spawner.radius;
    this._foes.launched(spawner);
    fx.flare(mx, my, { color: COLORS.qixBurst[1], radius: 3.5, life: 0.3 });
    fx.explode(mx, my, { colors: COLORS.qixBurst, count: 160, speed: 14, life: 0.5, size: 0.13, angle: a, spread: 1.1, glow: 0.1 });
    // The recoil ring.
    fx.shockwave(spawner.x, spawner.y, { color: COLORS.spawner, radius: spawner.radius + 2.5, life: 0.45, width: 0.35 });
    fx.shake(0.25);
  }

  onChipperImpact(x, y, regionId, hits) {
    const fx = this.effects;
    const severity = regionId > 0 ? clamp01(hits / TUNING.chipperHits) : 0;
    this._foes.impact(x, y);
    fx.sparks(x, y, { colors: COLORS.chipperBurst, count: Math.round(18 + 30 * severity), speed: 8 + 6 * severity, life: 0.45 });
    if (!(regionId > 0)) return;
    this._damage.impact(this.grid, x, y, regionId, hits);
    fx.sparks(x, y, { colors: SEAL_COLORS, count: Math.round(14 + 20 * severity), speed: 7 });
    fx.shockwave(x, y, { color: COLORS.chipper, radius: 1.5 + 2 * severity, life: 0.3, width: 0.25 });
    fx.shake(0.12 + 0.3 * severity);
  }

  onRegionShattered(result) {
    if (!result) return;
    const fx = this.effects;
    const { centroid } = result;
    const size = Math.sqrt(result.cells ? result.cells.length : 0);
    this._board.shatter(result);
    this._damage.shatter(result);
    fx.hitStop(SHATTER_HIT_STOP);
    fx.flash(COLORS.ice[0], 0.4, 0.5, { ...centroid, radius: 8 + size });
    fx.flare(centroid.x, centroid.y, { color: COLORS.chipperBurst[1], radius: 5 + size * 0.4, life: 0.5 });
    fx.explode(centroid.x, centroid.y, { colors: SHATTER_COLORS, count: Math.round(300 + size * 20), speed: 12 + size * 0.5, life: 1, size: 0.16, glow: 0.08 });
    fx.shockwave(centroid.x, centroid.y, { color: COLORS.ice[0], radius: 3 + size * 0.5, life: 0.6, width: 0.5 });
    fx.shockwave(centroid.x, centroid.y, { color: COLORS.chipper, radius: 5 + size * 0.7, life: 0.9, width: 0.6, delay: 0.08 });
    fx.shake(Math.min(1, 0.4 + size * 0.03));
    // Mirrors the capture popup: the HUD readout drops by exactly this.
    const percent = floorPercent(result.fractionBefore) - floorPercent(result.fractionAfter);
    if (percent >= 1) fx.popup(centroid.x, Math.max(centroid.y, POPUP_FLOOR), `−${percent}%`, { color: COLORS.chipperBurst[1] });
  }

  onPickupSpawned(pickup) {
    if (!pickup) return;
    const fx = this.effects;
    const color = COLORS.powers[pickup.type] || COLORS.ice[0];
    this._pickups.spawned(pickup);
    fx.shockwave(pickup.x, pickup.y, { color, radius: 2.4, life: 0.45, width: 0.25 });
    fx.flare(pickup.x, pickup.y, { color, radius: 2.6, life: 0.35 });
  }

  onPickupCollected(pickup) {
    if (!pickup) return;
    const fx = this.effects;
    const color = COLORS.powers[pickup.type] || COLORS.ice[0];
    this._pickups.collected(pickup);
    fx.sparks(pickup.x, pickup.y, { colors: POWER_BURSTS[pickup.type] || SEAL_COLORS, count: 50, speed: 11, life: 0.6 });
    fx.flare(pickup.x, pickup.y, { color, radius: 4, life: 0.4 });
    fx.shockwave(pickup.x, pickup.y, { color, radius: 3.5, life: 0.5, width: 0.3 });
    const label = POWER_LABELS[pickup.type];
    if (label) fx.popup(pickup.x, Math.max(pickup.y - 0.6, POPUP_FLOOR), label, { color });
  }

  onPickupExpired(pickup) {
    if (!pickup) return;
    this._pickups.expired(pickup);
    this.effects.shockwave(pickup.x, pickup.y, { color: COLORS.powers[pickup.type] || COLORS.ice[0], radius: 1.4, life: 0.3, width: 0.15 });
  }

  onPowerStart(type, player) {
    const fx = this.effects;
    this._look.started(type);
    if (!player) return;
    const { x, y } = player;
    const color = COLORS.powers[type] || COLORS.ice[0];
    const reach = this.grid ? Math.hypot(this.grid.cols, this.grid.rows) : 60; // board diagonal, cells
    switch (type) {
      case 'freeze':
        // The cold rolls out across the whole board.
        fx.shockwave(x, y, { color, radius: reach * 0.7, life: 0.9, width: 0.9 });
        fx.flash(color, 0.35, 0.6, { x, y, radius: 30 });
        break;
      case 'slow':
        fx.shockwave(x, y, { color, radius: reach * 0.5, life: 1.4, width: 1.2 });
        fx.flash(color, 0.2, 0.7, { x, y, radius: 24 });
        break;
      case 'shield':
        fx.shockwave(x, y, { color, radius: 3, life: 0.4, width: 0.3 });
        fx.sparks(x, y, { colors: POWER_BURSTS.shield, count: 30, speed: 6, life: 0.4 });
        break;
      case 'life':
        fx.shockwave(x, y, { color, radius: 4, life: 0.5, width: 0.35 });
        fx.sparks(x, y, { colors: CORE_COLORS, count: 40, speed: 9 });
        break;
      default:
        // speed, cut: a quick ring and a flare in the power's colour.
        fx.shockwave(x, y, { color, radius: 3.2, life: 0.4, width: 0.3 });
        fx.flare(x, y, { color, radius: 3, life: 0.3 });
    }
  }

  onShieldBreak(x, y) {
    const fx = this.effects;
    const color = COLORS.powers.shield;
    this._look.shieldBroke();
    this._actors.shieldBroke();
    fx.hitStop(SHIELD_HIT_STOP);
    fx.sparks(x, y, { colors: POWER_BURSTS.shield, count: 70, speed: 13, life: 0.6 });
    fx.flare(x, y, { color, radius: 5, life: 0.35 });
    fx.shockwave(x, y, { color, radius: 5, life: 0.45, width: 0.4 });
    fx.flash(color, 0.35, 0.35, { x, y, radius: 14 });
    fx.shake(0.5);
  }

  onInstantCut(cells) {
    if (!cells || !cells.length) return;
    const fx = this.effects;
    const end = cells[cells.length - 1];
    const color = COLORS.powers.cut;
    this._actors.instantCut(cells);
    fx.flare(end.x, end.y, { color, radius: 4, life: 0.35 });
    fx.flash(color, 0.25, 0.3, { x: end.x, y: end.y, radius: 12 });
    fx.shake(0.3);
  }

  onSparxBurst(x, y) {
    const fx = this.effects;
    fx.explode(x, y, { colors: COLORS.sparxBurst, count: 520, speed: 19, life: 1, size: 0.15, glow: 0.08 });
    fx.flare(x, y, { color: COLORS.sparxBurst[1], radius: 6, life: 0.4 });
    fx.shockwave(x, y, { color: COLORS.sparx, radius: 7, life: 0.55, width: 0.4 });
  }

  onWin(grid, origin = this._actors.lastPlayerPosition(grid)) {
    const fx = this.effects;
    if (grid !== this.grid) this.setGrid(grid);
    this._board.startFlood(origin);
    fx.flash(COLORS.ice[0], 0.5, 0.8, origin);
    fx.shake(0.5);
    fx.shockwave(origin.x, origin.y, { color: COLORS.ice[0], radius: Math.hypot(grid.cols, grid.rows) * 0.6, life: 1.1, width: 0.8 });
    const y = grid.rows - 1.5;
    for (let k = 0; k < FOUNTAIN_BURSTS; k++) {
      const x = grid.cols * (0.22 + 0.28 * (k % 3));
      fx.schedule(0.25 + k * 0.055, () => {
        fx.explode(x, y, {
          colors: FOUNTAIN_COLORS, count: 100, speed: 64, life: 1.7, size: 0.22,
          drag: 0.3, gravity: 42, angle: -Math.PI / 2, spread: 0.7, glow: 0.1, additive: false,
        });
      });
    }
  }

  /** Shake in CSS px: bounded by the baked background margin, snapped to device pixels so layers stay crisp. */
  _shakePx(cells) {
    const px = Math.max(-BG_MARGIN, Math.min(BG_MARGIN, cells * this.cellSize));
    return Math.round(px * this.dpr) / this.dpr;
  }

  // ── Frame ────────────────────────────────────────────────────────────────

  render(scene, dt) {
    const { ctx, dpr } = this;
    if (scene.grid && scene.grid !== this.grid) this.setGrid(scene.grid);
    // Built while the game screen was still hidden: pick the layout up as soon as the canvas has a box.
    if (!this.cellPx) this.resize();
    if (!this.grid || !this.cellPx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    const step = Math.min(MAX_FRAME, Math.max(0, dt || 0));
    const foes = scene.foes || NONE;
    this.time += step;
    this.effects.update(step);
    this._board.update(step);
    this._look.update(scene, step);
    this._actors.update(scene, step);
    this._foes.update(foes, step);
    this._pickups.update(step);
    this._damage.update(step);

    this.shiftX = this._shakePx(this.effects.shakeX);
    this.shiftY = this._shakePx(this.effects.shakeY);
    ctx.setTransform(dpr, 0, 0, dpr, this.shiftX * dpr, this.shiftY * dpr);

    this._board.drawBackground(ctx, this.time);
    this._board.drawIce(ctx, this.time);
    this._damage.drawCracks(ctx, this, this.time);
    this._board.drawRail(ctx);
    // Blast scorches darken the ground, never a sprite: the arrowhead must stay bright beside its own kill.
    this.effects.drawUnder(ctx, this);
    this._damage.drawShards(ctx, this);
    this._pickups.draw(ctx, this, scene.pickups || NONE);
    this._actors.drawLines(ctx, this, scene);
    this._foes.draw(ctx, this, foes);
    this._actors.drawBodies(ctx, this, scene);
    this._look.drawVignette(ctx, this);
    this.effects.draw(ctx, this);
  }
}
