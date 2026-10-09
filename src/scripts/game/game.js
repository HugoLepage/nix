import { computeGridSize, MAX_LIVES, POWERS, START_LIVES, TUNING, WIN_FRACTION } from '../config.js';
import { createFoe, placeFoes } from './foes.js';
import { Grid } from './grid.js';
import { getLevel } from './levels.js';
import { Player } from './player.js';
import { PowerUps } from './powers.js';
import { Renderer } from './renderer.js';
import { Sparx, spreadTwins } from './sparx.js';

const MAX_DT = 0.05; // seconds of simulation per frame, at most
const SUB_STEP = 1 / 120; // keeps head-on player/sparx passes from skipping the hit test at low frame rates
const RESUME_GRACE = 3; // frames the simulation stays frozen after a resume
const RELOCATE_INVULN = 1; // seconds of blink after a shatter moved the arrowhead off land that vanished
const DEBUG_STATES = new Set(['intro', 'playing', 'paused', 'dying']);

/**
 * One level of Nix on a canvas: the simulation, its state machine and the render loop.
 *
 * States: 'idle' → load() → 'intro' → begin() → 'playing' | 'dying' ⇄ 'paused'
 *         'playing' → 'dying' → 'playing' | 'lost'      'playing' → 'won'
 * Events: 'state' {state, prev}, 'lives' {lives}, 'progress' {fraction, gained} (gained < 0 when a chipper
 *         shatters a region), 'foeDestroyed' {kind}, 'pickup' {type}, 'shatter' {regionId, fraction},
 *         'powers' {speed, freeze, slow, shield, cut} (a snapshot, sent when a power starts, ends, absorbs a hit
 *         or is cleared), 'win' {level, time, fraction}, 'lose' {level}.
 * The loop renders in every state (effects keep playing); the simulation advances only while
 * 'playing' or 'dying', and for the enemies alone once 'lost'. Power timers and pick-ups run in 'playing'
 * only, and the sparx hold still from a death until the respawned arrowhead's first move (and at level start); the
 * respawn blink waits for that move too. `foes`, `pickups` and `powers` are the live objects the renderer draws.
 */
export class Game {
  /** `renderer` replaces the canvas renderer (a headless run); it must offer the same API. */
  constructor(canvas, { lowPower = false, renderer = null } = {}) {
    this.canvas = canvas;
    this.renderer = renderer || new Renderer(canvas, { lowPower });
    this.grid = null;
    this.player = null;
    this.sparx = [];
    this.foes = [];
    this._powerUps = new PowerUps();
    this._regionHits = new Map(); // captured region id → chipper impacts taken
    this._spared = new Set(); // foes whose blow a shield took: harmless until they let go of the line and the ship
    this._world = { player: null, liveQix: 0 }; // what the foes react to while they move
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
    this._scene = {
      grid: null,
      player: null,
      sparx: this.sparx,
      foes: this.foes,
      pickups: this._powerUps.pickups,
      powers: this._powerUps.active,
      time: 0,
      state: 'idle',
    };
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

  /** The running powers: { speed, freeze, slow } in seconds left (0 = off), `shield` up, `cut` armed. Read-only. */
  get powers() {
    return this._powerUps.active;
  }

  /** The pick-ups waiting in the field. Read-only. */
  get pickups() {
    return this._powerUps.pickups;
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
    this.foes.length = 0;
    const sparxStart = grid.spawnCell('bottom');
    for (const s of def.sparx) this.sparx.push(new Sparx(grid, { ...s, ...sparxStart }));
    spreadTwins(grid, this.sparx);
    for (const f of def.foes) this.foes.push(createFoe(grid, f));
    placeFoes(grid, this.foes, this.player);
    this._powerUps.reset(def.powerups, def.intro);
    this._regionHits.clear();
    this._spared.clear();
    this._world.player = this.player;
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
    this._emitPowers();
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

  // ── Debug (QA) ───────────────────────────────────────────────────────────

  /** Applies power `type` now, as if its pick-up had just been collected. Returns whether it did. */
  debugGrant(type) {
    if (!POWERS[type] || !DEBUG_STATES.has(this._state)) return false;
    this._grant(type);
    return true;
  }

  /** Puts a `type` pick-up in the field now (replacing any waiting one), on the qualifying cell nearest the middle. */
  debugPickup(type) {
    if (!POWERS[type] || !DEBUG_STATES.has(this._state)) return null;
    for (const pickup of this._powerUps.clearField()) this.renderer.onPickupExpired(pickup);
    const pickup = this._powerUps.drop(type, this.grid, this.player, this.foes);
    if (pickup) this.renderer.onPickupSpawned(pickup);
    return pickup;
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
      this._updatePowers(h);
      player.boost = this._powerUps.active.speed > 0 ? TUNING.playerBoost : 1;
      for (const event of player.update(h)) {
        if (event.type === 'cut') this._onCut(event.cells);
        else if (event.type === 'capture') this._onCapture(event.result);
      }
      if (this._state !== 'playing') return;
    }

    // Every enemy clock runs on scaled time (time stop, slow-mo). The sparx also wait for the arrowhead to move.
    const enemyDt = h * this._powerUps.enemyScale;
    if (player.alive && player.moved) for (const sparx of this.sparx) sparx.update(enemyDt, player);
    this._updateFoes(enemyDt);

    if (this._state === 'playing') {
      this._collect();
      this._collide();
    } else if (this._state === 'dying') {
      this._deathTimer -= h;
      if (this._deathTimer <= 0) this._respawn();
    }
  }

  _updatePowers(h) {
    const { renderer } = this;
    const lifeOk = this._lives < MAX_LIVES; // a full set of lives draws no extra life
    for (const event of this._powerUps.update(h, this.grid, this.player, this.foes, lifeOk)) {
      if (event.type === 'ended') this._emitPowers();
      else if (event.type === 'spawned') renderer.onPickupSpawned(event.pickup);
      else if (event.type === 'expired') renderer.onPickupExpired(event.pickup);
    }
  }

  _updateFoes(dt) {
    if (!(dt > 0)) return;
    const { foes } = this;
    const world = this._world;
    world.player = this.player;
    world.liveQix = foes.reduce((n, foe) => n + (foe.alive && foe.kind === 'qix' ? 1 : 0), 0);
    // A launched qix joins the array mid-walk: it takes its first step on the next update.
    for (let i = 0, n = foes.length; i < n; i++) {
      const foe = foes[i];
      for (const event of foe.update(dt, world)) {
        if (event.type === 'impact') this._onImpact(event);
        else if (event.type === 'launch') this._onLaunch(foe);
      }
    }
  }

  _collide() {
    const { player, foes } = this;
    // Sealed in by its own trail: no move could ever capture again, and no shield helps with that.
    if (player.trapped) return this._die();
    // The foe that broke the shield passes on through: a big, slow spawner can take longer to cross the line than the
    // grace lasts, and must not land the very blow the shield just took. It is forgotten as soon as it lets go, even
    // inside the grace, so a fresh touch after that is a fresh blow.
    const spared = this._spared;
    for (const foe of spared) if (!foe.alive || (!foe.hitsTrail() && !foe.hitsShip(player))) spared.delete(foe);
    // Just after the shield took a hit: nothing touches the ship or its line.
    if (this._powerUps.immune) return;
    // A foe touching the unfinished trail costs a life even through the respawn blink: that guards the arrowhead only.
    for (const foe of foes) {
      if (foe.alive && !spared.has(foe) && foe.hitsTrail()) return this._hit(this._trailContact(foe), foe);
    }
    if (player.invuln > 0) return;
    const reach = TUNING.sparxHitDist * TUNING.sparxHitDist;
    for (const sparx of this.sparx) {
      if (!sparx.alive) continue;
      const dx = sparx.x - player.x;
      const dy = sparx.y - player.y;
      if (dx * dx + dy * dy < reach) return this._hit(player);
    }
    for (const foe of foes) if (foe.alive && !spared.has(foe) && foe.hitsShip(player)) return this._hit(player, foe);
  }

  /** The trail cell nearest a foe that touches the line: where a shield takes that blow. */
  _trailContact(foe) {
    let best = foe;
    let bestDist = Infinity;
    for (const c of this.grid.trail) {
      const d = (c.x - foe.x) ** 2 + (c.y - foe.y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best;
  }

  /** A blow landed at `at` ({x, y}), dealt by `foe` (null for a sparx): fatal, unless a shield is up to take it. */
  _hit(at, foe = null) {
    if (!this._powerUps.active.shield) return this._die();
    const { player } = this;
    this._powerUps.absorb();
    if (foe) this._spared.add(foe);
    player.invuln = Math.max(player.invuln, TUNING.shieldGrace);
    this.renderer.onShieldBreak(at.x, at.y);
    this._emitPowers();
  }

  // ── Moments ──────────────────────────────────────────────────────────────

  _onCapture(result) {
    const { grid, renderer } = this;
    renderer.onCapture(result);
    for (const sparx of this.sparx) sparx.onGridChanged();
    for (const foe of this.foes) {
      if (!foe.alive) continue;
      const { x, y } = foe.cell;
      if (!grid.isSolid(x, y)) continue;
      foe.alive = false;
      renderer.onFoeDestroyed(foe);
      this._emit('foeDestroyed', { kind: foe.kind });
    }
    this._pruneFoes();
    for (const pickup of this._powerUps.captured(grid)) this._collected(pickup);
    this._emit('progress', { fraction: grid.fraction, gained: result.fractionAfter - result.fractionBefore });
    if (grid.fraction >= WIN_FRACTION) this._win();
  }

  _onCut(cells) {
    this.renderer.onInstantCut(cells);
    this._powerUps.active.cut = false;
    this._emitPowers();
  }

  /** A chipper bounced off land. Captured regions crack, and give way at the `chipperHits`th impact. */
  _onImpact({ x, y, regionId }) {
    // The outer wall never gives; neither does anything once the level is lost (the chipper only throws sparks).
    if (!regionId || this._state === 'lost') return this.renderer.onChipperImpact(x, y, 0, 0);
    const hits = (this._regionHits.get(regionId) || 0) + 1;
    this.renderer.onChipperImpact(x, y, regionId, hits);
    if (hits < TUNING.chipperHits) this._regionHits.set(regionId, hits);
    else this._shatter(regionId);
  }

  /** A captured region shatters back to open field: whoever stood on it is moved to the nearest rail. */
  _shatter(regionId) {
    const { grid, player } = this;
    this._regionHits.delete(regionId);
    const result = grid.revertRegion(regionId);
    if (!result) return;
    this.renderer.onRegionShattered(result);
    for (const sparx of this.sparx) sparx.onGridChanged();
    if (player.alive) {
      if (player.drawing) player.onGridChanged();
      else if (!this._onLand(player.cell) || (player.target && !this._onLand(player.target))) this._relocate();
    }
    this._emit('progress', { fraction: grid.fraction, gained: result.fractionAfter - result.fractionBefore });
    this._emit('shatter', { regionId, fraction: grid.fraction });
  }

  _onLand(cell) {
    return this.grid.isSolid(cell.x, cell.y);
  }

  /** Not a death: lives, powers and the sparx's licence to move stay as they were. */
  _relocate() {
    const { grid, player } = this;
    const { moved } = player;
    player.spawn(grid.nearestFrontier(player.x, player.y) || grid.spawnCell('top'));
    player.moved = moved;
    player.invuln = Math.max(player.invuln, RELOCATE_INVULN);
    this.renderer.onPlayerSpawn(player);
  }

  /** A spawner fired. The renderer reads the port off `nextPort`, so the port only turns afterwards. */
  _onLaunch(spawner) {
    const qix = spawner.launch();
    this.foes.push(qix);
    this._world.liveQix++;
    this.renderer.onFoeLaunched(spawner, qix);
    spawner.turnPort();
  }

  _collect() {
    const pickup = this._powerUps.touched(this.player);
    if (pickup) this._collected(pickup);
  }

  /** The arrowhead touched a pick-up, or a capture closed over it: it leaves the field and its power starts. */
  _collected(pickup) {
    this._powerUps.take(pickup);
    // An extra life with every life slot full gives nothing, so it folds away like an expired one: no fanfare.
    if (pickup.type === 'life' && this._lives >= MAX_LIVES) return this.renderer.onPickupExpired(pickup);
    this.renderer.onPickupCollected(pickup);
    this._emit('pickup', { type: pickup.type });
    this._grant(pickup.type);
  }

  /** Power `type` takes effect now. A timed one that is already running starts over at full length. */
  _grant(type) {
    const { player } = this;
    if (type === 'life') {
      if (this._lives >= MAX_LIVES) return; // capped: nothing changes, so nothing to show
      this._lives++;
      this._emit('lives', { lives: this._lives });
    } else {
      this._powerUps.start(type);
      if (type === 'cut') player.cutArmed = true;
    }
    this.renderer.onPowerStart(type, player);
    if (type !== 'life') this._emitPowers();
  }

  /** Death, or the end of the level, takes every power with it. */
  _clearPowers() {
    const { player } = this;
    player.boost = 1;
    player.cutArmed = false;
    if (this._powerUps.clear()) this._emitPowers();
  }

  _die() {
    const { player, renderer } = this;
    player.kill();
    renderer.onPlayerDeath(player.x, player.y);
    renderer.onTrailCleared(this.grid.clearTrail());
    this._spared.clear();
    this._clearPowers();
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
    // The level is over: its powers go (as on a death), and the arrowhead parks where it is.
    this._clearPowers();
    player.dir = player.want = null;
    for (const sparx of this.sparx) {
      if (!sparx.alive) continue;
      sparx.alive = false;
      renderer.onSparxBurst(sparx.x, sparx.y);
    }
    for (const foe of this.foes) {
      if (!foe.alive) continue;
      foe.alive = false;
      renderer.onFoeDestroyed(foe);
    }
    this._pruneFoes();
    for (const pickup of this._powerUps.clearField()) renderer.onPickupExpired(pickup);
    renderer.onWin(this.grid, { x: player.x, y: player.y });
    this._emit('win', { level: this._level, time: Math.round(this._elapsed * 10) / 10, fraction: this.grid.fraction });
  }

  /** Drops dead foes, in place: the scene shares the array. */
  _pruneFoes() {
    const { foes } = this;
    let n = 0;
    for (const foe of foes) if (foe.alive) foes[n++] = foe;
    foes.length = n;
  }

  // ── Events ───────────────────────────────────────────────────────────────

  _emitPowers() {
    this._emit('powers', this._powerUps.snapshot());
  }

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
