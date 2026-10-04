import { computeGridSize, START_LIVES, TUNING, WIN_FRACTION } from '../config.js';
import { Grid } from './grid.js';
import { getLevel } from './levels.js';
import { Player } from './player.js';
import { Qix } from './qix.js';
import { Renderer } from './renderer.js';
import { Sparx } from './sparx.js';

const MAX_DT = 0.05; // seconds of simulation per frame, at most
const SUB_STEP = 1 / 120; // keeps head-on player/sparx passes from skipping the hit test at low frame rates
const RESUME_GRACE = 3; // frames the simulation stays frozen after a resume

/**
 * One level of Nix on a canvas: the simulation, its state machine and the render loop.
 *
 * States: 'idle' → load() → 'intro' → begin() → 'playing' | 'dying' ⇄ 'paused'
 *         'playing' → 'dying' → 'playing' | 'lost'      'playing' → 'won'
 * Events: 'state' {state, prev}, 'lives' {lives}, 'progress' {fraction, gained}, 'qixDestroyed' {},
 *         'win' {level, time, fraction}, 'lose' {level}.
 * The loop renders in every state (effects keep playing); the simulation advances only while
 * 'playing' or 'dying', and for the enemies alone once 'lost'.
 */
export class Game {
  constructor(canvas, { lowPower = false } = {}) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas, { lowPower });
    this.grid = null;
    this.player = null;
    this.sparx = [];
    this.qixes = [];
    this._state = 'idle';
    this._level = 0;
    this._lives = 0;
    this._elapsed = 0;
    this._deathTimer = 0;
    this._grace = 0;
    this._resumeTo = 'playing';
    this._time = 0;
    this._last = 0;
    this._frame = 0;
    this._stopped = false;
    this._needsResize = false;
    this._handlers = new Map();
    this._scene = { grid: null, player: null, sparx: this.sparx, qixes: this.qixes, time: 0, state: 'idle' };
    this._tick = (now) => this._loop(now);

    this._listeners = new AbortController();
    const { signal } = this._listeners;
    const resize = () => (this._needsResize = true);
    window.addEventListener('resize', resize, { signal });
    window.addEventListener('orientationchange', resize, { signal });
    this._observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    this._observer?.observe(canvas);
    document.addEventListener('visibilitychange', () => document.hidden && this.pause(), { signal });

    if (location.hostname === 'localhost') window.__nix = this;
    this._frame = requestAnimationFrame(this._tick);
  }

  get state() {
    return this._state;
  }

  get level() {
    return this._level;
  }

  get lives() {
    return this._lives;
  }

  get fraction() {
    return this.grid ? this.grid.fraction : 0;
  }

  get elapsed() {
    return this._elapsed;
  }

  /** Subscribes to an event; returns the unsubscribe function. */
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this._handlers.get(type)?.delete(fn);
  }

  /** Builds a fresh attempt at `levelNumber`, shaped to the canvas, frozen in 'intro'. */
  load(levelNumber) {
    const def = getLevel(levelNumber);
    if (!def) throw new RangeError(`Unknown level ${levelNumber}`);
    const { renderer } = this;
    // Measure only: the grid is shaped to the fresh box, and setGrid() below bakes the layers once for it.
    renderer.measure();
    this._needsResize = false;
    const area = renderer.playArea;
    const { cols, rows } = computeGridSize(area.width, area.height);
    const grid = new Grid(cols, rows);

    this.grid = grid;
    this.player = new Player(grid);
    this.sparx.length = 0;
    this.qixes.length = 0;
    const sparxStart = grid.spawnCell('bottom');
    for (const s of def.sparx) this.sparx.push(new Sparx(grid, { ...s, ...sparxStart }));
    for (const q of def.qix) this.qixes.push(new Qix(grid, { ...q }));
    this._scene.grid = grid;
    this._scene.player = this.player;
    renderer.setGrid(grid);

    this._level = def.id;
    this._lives = START_LIVES;
    this._elapsed = 0;
    this._deathTimer = 0;
    this._grace = 0;
    this._setState('intro');
    this._emit('lives', { lives: this._lives });
    this._emit('progress', { fraction: 0, gained: 0 });
  }

  begin() {
    if (this._state !== 'intro') return;
    this.renderer.onPlayerSpawn(this.player);
    this._setState('playing');
  }

  /** Also during the death pause: a hidden tab or a lost fullscreen then must not respawn the player unseen. */
  pause() {
    if (this._state !== 'playing' && this._state !== 'dying') return;
    this._resumeTo = this._state;
    this._setState('paused');
  }

  /** Back to the state pause() interrupted; a paused death keeps the rest of its timer. */
  resume() {
    if (this._state !== 'paused') return;
    this._grace = RESUME_GRACE;
    this._setState(this._resumeTo);
  }

  restart() {
    if (this._level) this.load(this._level);
  }

  /** Ends the session for good: no more frames, listeners or events. Safe to call twice. */
  stop() {
    if (this._stopped) return;
    this._stopped = true;
    cancelAnimationFrame(this._frame);
    this._listeners.abort();
    this._observer?.disconnect();
    this._handlers.clear();
    if (window.__nix === this) delete window.__nix;
  }

  input(name) {
    if (this._state === 'playing' && this.player.alive) this.player.setWanted(name);
  }

  resize() {
    this._needsResize = false;
    this.renderer.resize();
  }

  // ── Loop ─────────────────────────────────────────────────────────────────

  _loop(now) {
    if (this._stopped) return;
    // Scheduled first: an exception in one frame must not freeze the game for good.
    this._frame = requestAnimationFrame(this._tick);
    const dt = this._last ? Math.max(0, (now - this._last) / 1000) : 0;
    this._last = now;
    if (this._needsResize) this.resize();

    if (this._simulating()) {
      let sim = Math.min(MAX_DT, dt) * this.renderer.effects.timeScale;
      if (this._grace > 0) {
        this._grace--;
        sim = 0;
      }
      while (sim > 1e-9 && this._simulating()) {
        const h = Math.min(SUB_STEP, sim);
        sim -= h;
        this._step(h);
      }
    }

    this._time += dt;
    this._scene.time = this._time;
    this._scene.state = this._state;
    if (this.grid) this.renderer.render(this._scene, dt);
  }

  /** The enemies keep roaming behind the final explosion; only the player's clock and moves stop. */
  _simulating() {
    return this._state === 'playing' || this._state === 'dying' || this._state === 'lost';
  }

  _step(h) {
    const { player } = this;
    if (this._state !== 'lost') this._elapsed += h;

    if (this._state === 'playing') {
      for (const event of player.update(h)) {
        if (event.type === 'capture') this._onCapture(event.result);
      }
      if (this._state !== 'playing') return;
    }

    const target = player.alive ? player : null;
    for (const sparx of this.sparx) sparx.update(h, target);
    for (const qix of this.qixes) qix.update(h);

    if (this._state === 'playing') {
      this._collide();
    } else if (this._state === 'dying') {
      this._deathTimer -= h;
      if (this._deathTimer <= 0) this._respawn();
    }
  }

  _collide() {
    const { player } = this;
    // Sealed in by its own trail: no move could ever capture again.
    if (player.trapped) return this._die();
    // A qix touching the unfinished trail always costs a life: the respawn shield guards the arrowhead only.
    for (const qix of this.qixes) if (qix.alive && qix.hitsTrail()) return this._die();
    if (player.invuln > 0) return;
    const reach = TUNING.sparxHitDist * TUNING.sparxHitDist;
    for (const sparx of this.sparx) {
      if (!sparx.alive) continue;
      const dx = sparx.x - player.x;
      const dy = sparx.y - player.y;
      if (dx * dx + dy * dy < reach) return this._die();
    }
    for (const qix of this.qixes) {
      if (qix.alive && qix.hitsPoint(player.x, player.y, TUNING.qixHitSlack)) return this._die();
    }
  }

  _onCapture(result) {
    const { grid, renderer } = this;
    renderer.onCapture(result);
    for (const sparx of this.sparx) sparx.onGridChanged();
    for (const qix of this.qixes) {
      if (!qix.alive) continue;
      const { x, y } = qix.cell;
      if (!grid.isSolid(x, y)) continue;
      qix.alive = false;
      renderer.onQixDestroyed(qix.x, qix.y, qix.radius);
      this._emit('qixDestroyed', {});
    }
    this._emit('progress', { fraction: grid.fraction, gained: result.fractionAfter - result.fractionBefore });
    if (grid.fraction >= WIN_FRACTION) this._win();
  }

  _die() {
    const { player, renderer } = this;
    player.kill();
    renderer.onPlayerDeath(player.x, player.y);
    renderer.onTrailCleared(this.grid.clearTrail());
    this._lives--;
    this._emit('lives', { lives: this._lives });
    if (this._lives > 0) {
      this._deathTimer = TUNING.deathPause;
      this._setState('dying');
    } else {
      this._setState('lost');
      this._emit('lose', { level: this._level });
    }
  }

  _respawn() {
    const { player } = this;
    player.spawn(this.grid.spawnCell('top'));
    player.invuln = TUNING.respawnInvuln;
    this.renderer.onPlayerSpawn(player);
    this._setState('playing');
  }

  _win() {
    const { player, renderer } = this;
    this._setState('won');
    for (const sparx of this.sparx) {
      if (!sparx.alive) continue;
      sparx.alive = false;
      renderer.onSparxBurst(sparx.x, sparx.y);
    }
    for (const qix of this.qixes) {
      if (!qix.alive) continue;
      qix.alive = false;
      renderer.onQixDestroyed(qix.x, qix.y, qix.radius);
    }
    renderer.onWin(this.grid, { x: player.x, y: player.y });
    this._emit('win', { level: this._level, time: Math.round(this._elapsed * 10) / 10, fraction: this.grid.fraction });
  }

  // ── Events ───────────────────────────────────────────────────────────────

  _setState(state) {
    const prev = this._state;
    if (state === prev) return;
    this._state = state;
    this._emit('state', { state, prev });
  }

  _emit(type, payload) {
    const handlers = this._handlers.get(type);
    if (!handlers) return;
    for (const fn of [...handlers]) {
      // A broken listener must not abort the frame that is mid-way through a capture or a death.
      try {
        fn(payload);
      } catch (err) {
        reportError(err);
      }
    }
  }
}
