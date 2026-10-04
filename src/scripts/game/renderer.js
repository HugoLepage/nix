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
 *   setGrid(grid)      new level: drops every running effect, rebuilds all layers
 *   resize()           re-reads the canvas CSS box + devicePixelRatio, re-bakes if either changed; safe at any time
 *   measure()          the same re-read without the re-bake (a setGrid() follows); returns whether anything changed
 *   render(scene, dt)  draws one frame and ADVANCES ALL VISUAL TIME, effects included — do not
 *                      call effects.update() yourself. `dt` must be the REAL frame time in
 *                      seconds (not multiplied by effects.timeScale), in every game state.
 *       scene = { grid, player, sparx: [], qixes: [], time, state, fractionShown }
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
 *     onPlayerSpawn(player)          materialise rings + sparks; call on every (re)spawn
 *     onPlayerDeath(x, y)            ~90 ms hit-stop, then the big explosion
 *     onQixDestroyed(x, y, radius)   ribbon shatters, bigger and slower magenta bloom
 *     onSparxBurst(x, y)             amber burst (win sequence)
 *     onWin(grid, origin?)           floods the remaining open cells + particle fountain. Visual
 *                                    only: the grid is never mutated. `origin` defaults to the
 *                                    player's last position. Burst the enemies separately with
 *                                    onSparxBurst / onQixDestroyed and mark them alive = false.
 *
 *   The rail re-bakes itself whenever grid.version changes; nothing to call for that.
 *   Internals live in fx-board.js (baked layers, fill waves, sheen), fx-actors.js (trail and
 *   entities + their visual state) and fx-util.js (colour / sprite / easing helpers).
 */
import { COLORS } from '../config.js';
import { Effects } from './effects.js';
import { Actors } from './fx-actors.js';
import { BG_MARGIN, BoardLayers } from './fx-board.js';

const MAX_DPR = 2;
const MAX_FRAME = 0.1; // seconds; a stalled tab must not fast-forward the animations
const DEFAULT_INSETS = { top: 56, right: 10, bottom: 46, left: 10 };
const DEATH_HIT_STOP = 0.09;
const QIX_HIT_STOP = 0.07;
const FOUNTAIN_BURSTS = 32;
const SEAL_COLORS = ['#ffffff', COLORS.ice[0], COLORS.ice[1], COLORS.ice[3]];
// Gold, not ice: by the time the fountain plays the whole board is light blue, and only a warm hue reads on it.
// Blended flat (additive: false), since gold added onto light-blue ice saturates to white.
const FOUNTAIN_COLORS = ['#fff3c4', '#ffd166', COLORS.sparx, '#ff9f1c'];
const CORE_COLORS = ['#ffffff', '#ffffff', COLORS.ice[0], COLORS.ice[2]];
const QIX_CORE_COLORS = ['#ffffff', '#ffffff', COLORS.qixBurst[1], COLORS.qixBurst[3]];

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
    this._board = new BoardLayers(this.effects, { lowPower });
    this._actors = new Actors(this.effects, { lowPower });
    this.resize();
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
    this._actors.reset();
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
    // It rises 2.6 cells: starting at least 3.1 cells down keeps it clear of the top rail and the HUD above it.
    if (percent >= 1) fx.popup(centroid.x, Math.max(centroid.y, 3.1), `+${percent}%`);
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

  onQixDestroyed(x, y, radius = 1.3) {
    const fx = this.effects;
    const scale = Math.max(1, radius / 1.3);
    this._actors.qixShattered(x, y);
    fx.hitStop(QIX_HIT_STOP);
    fx.flare(x, y, { color: COLORS.qixBurst[1], radius: 6 * scale, life: 0.3 });
    fx.schedule(QIX_HIT_STOP, () => {
      // Lower speed and drag than the player's death: the cloud keeps unfolding for two seconds.
      fx.explode(x, y, { colors: COLORS.qixBurst, count: 4200, speed: 32 * scale, life: 2.4, size: 0.25, drag: 0.7, glow: 0.07 });
      fx.explode(x, y, { colors: QIX_CORE_COLORS, count: 520, speed: 10, life: 0.8, size: 0.15, glow: 0.1 });
      // A qix always dies inside freshly captured ice: without the bruise the magenta would wash out to white.
      fx.scorch(x, y, { radius: 15 * scale, life: 2.2, alpha: 0.85 });
      fx.flare(x, y, { color: COLORS.qixBurst[1], radius: 11 * scale, life: 0.6 });
      fx.shockwave(x, y, { color: COLORS.qixBurst[1], radius: 9 * scale, life: 0.5, width: 0.4 });
      fx.shockwave(x, y, { color: COLORS.qix, radius: 18 * scale, life: 1, width: 0.7, delay: 0.1 });
      fx.shockwave(x, y, { color: COLORS.qixBurst[3], radius: 27 * scale, life: 1.5, width: 0.9, delay: 0.24 });
      fx.flash(COLORS.qix, 0.6, 0.7, { x, y });
      fx.shake(1.3);
    });
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
    this.time += step;
    this.effects.update(step);
    this._board.update(step);
    this._actors.update(scene, step);

    this.shiftX = this._shakePx(this.effects.shakeX);
    this.shiftY = this._shakePx(this.effects.shakeY);
    ctx.setTransform(dpr, 0, 0, dpr, this.shiftX * dpr, this.shiftY * dpr);

    this._board.drawBackground(ctx, this.time);
    this._board.drawIce(ctx, this.time);
    this._board.drawRail(ctx);
    // Blast scorches darken the ground, never a sprite: the arrowhead must stay bright beside its own qix kill.
    this.effects.drawUnder(ctx, this);
    this._actors.draw(ctx, this, scene);
    this.effects.draw(ctx, this);
  }
}
