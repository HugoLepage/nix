import { POWERS, TUNING } from '../config.js';

const TIMED = ['speed', 'freeze', 'slow', 'shield'];
const LIFE_WEIGHT = 0.4; // extra lives turn up less often than the other powers (weight 1)
const SPAWN_TRIES = 40;
const RETRY = 1; // s before another try when no cell qualified (or the pool had nothing allowed to draw)
const LAND_GAP = 1; // cells around a pick-up that must hold no land: it sits at least 2 cells from any SOLID cell
const FOE_GAP = 6; // cells from every foe centre
const PLAYER_GAP = 5; // cells from the arrowhead

/**
 * The level's power-ups: the pick-up waiting in the field (one at a time, drawn from the level's pool) and the
 * powers running. `active` = { speed, freeze, slow, shield, cut }: seconds left for the four timed ones (0 = off;
 * a shield above 0 is up), `cut` = armed. A pick-up is `{ type, x, y, age, life, alive }` on an integer cell.
 * `update` is fed play time only, so everything here holds still through a pause and the death pause. What a
 * power does to the player, the lives and the screen is the game's business.
 */
export class PowerUps {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.active = { speed: 0, freeze: 0, slow: 0, shield: 0, cut: false };
    this.pickups = [];
    this.grace = 0; // s of total immunity left since the shield took a hit
    this._pool = [];
    this._first = null; // the power the level introduces, until the first pick-up is placed
    this._wait = 0; // s of play until the next pick-up tries to appear
    this._events = [];
  }

  /**
   * A fresh level: nothing running, nothing in the field, the first pick-up `pickupFirst` s into play. On a level
   * that introduces a power (`intro`), that first pick-up is the new power, whatever the weights say.
   */
  reset(pool, intro = null) {
    this._pool = pool.filter((type) => POWERS[type]);
    this._first = this._pool.includes(intro) ? intro : null;
    this.pickups.length = 0;
    this.clear();
    this._wait = TUNING.pickupFirst;
  }

  /** dt × this for every enemy clock (foes and sparx): 0 under time stop, the slow factor under slow-mo, else 1. */
  get enemyScale() {
    const { active } = this;
    return active.freeze > 0 ? 0 : active.slow > 0 ? POWERS.slow.factor : 1;
  }

  /** Just after the shield took a hit: nothing can touch the ship or its line. */
  get immune() {
    return this.grace > 0;
  }

  /** A copy of `active` for the 'powers' event. */
  snapshot() {
    return { ...this.active };
  }

  /** Starts (or restarts, at full length) a timed power, or arms the cut. 'life' is the game's alone. */
  start(type) {
    if (type === 'cut') this.active.cut = true;
    else if (TIMED.includes(type)) this.active[type] = POWERS[type].duration;
  }

  /** The shield took a hit: it is spent, and a short grace keeps the next blow from landing straight away. */
  absorb() {
    this.active.shield = 0;
    this.grace = TUNING.shieldGrace;
  }

  /** Ends every power (death). Returns whether any was running. */
  clear() {
    const { active } = this;
    const running = active.cut || TIMED.some((type) => active[type] > 0);
    for (const type of TIMED) active[type] = 0;
    active.cut = false;
    this.grace = 0;
    return running;
  }

  /**
   * Advances dt seconds of play: counts the powers down, ages the waiting pick-up and drops in the next one
   * (an extra life only while `lifeOk`: the lives are not all full). Returns the events ({type: 'ended'},
   * {type: 'spawned' | 'expired', pickup}) in an array that is reused by the next update, so consume it right away.
   */
  update(dt, grid, player, foes, lifeOk = true) {
    const events = this._events;
    events.length = 0;
    if (!(dt > 0)) return events;
    const { active } = this;
    this.grace = Math.max(0, this.grace - dt);
    let ended = false;
    for (const type of TIMED) {
      if (active[type] <= 0) continue;
      active[type] = Math.max(0, active[type] - dt);
      if (active[type] === 0) ended = true;
    }
    if (ended) events.push({ type: 'ended' });

    const waiting = this.pickups[0];
    if (waiting) {
      waiting.age += dt;
      if (waiting.age >= waiting.life) {
        this.take(waiting);
        events.push({ type: 'expired', pickup: waiting });
      }
    } else if (this._pool.length) {
      this._wait -= dt;
      if (this._wait <= 0) {
        const type = this._pick(lifeOk);
        const pickup = type && this._scatter(type, grid, player, foes);
        if (pickup) {
          this._first = null;
          events.push({ type: 'spawned', pickup });
        } else {
          this._wait = RETRY;
        }
      }
    }
    return events;
  }

  /** The pick-up the live arrowhead's centre is touching, if any. */
  touched(player) {
    if (!player.alive) return null;
    const reach = TUNING.pickupReach * TUNING.pickupReach;
    return this.pickups.find((p) => (p.x - player.x) ** 2 + (p.y - player.y) ** 2 < reach) || null;
  }

  /** The pick-ups a capture just closed over: their cell is land now. */
  captured(grid) {
    return this.pickups.filter((p) => grid.isSolid(p.x, p.y));
  }

  /** Takes `pickup` off the board (collected or expired); the next one follows after a random gap. */
  take(pickup) {
    const i = this.pickups.indexOf(pickup);
    if (i >= 0) this.pickups.splice(i, 1);
    pickup.alive = false;
    this._wait = TUNING.pickupGapMin + this.rng() * (TUNING.pickupGapMax - TUNING.pickupGapMin);
  }

  /** Empties the field (the level is won, or a debug drop replaces it). Returns what was waiting. */
  clearField() {
    const gone = this.pickups.splice(0);
    for (const pickup of gone) pickup.alive = false;
    return gone;
  }

  /**
   * Debug drop: a `type` pick-up on the qualifying cell nearest the board's middle, or on the open cell nearest
   * it when none qualifies. Returns it, or null on a board without open field.
   */
  drop(type, grid, player, foes) {
    const cx = (grid.cols - 1) / 2;
    const cy = (grid.rows - 1) / 2;
    let best = null;
    let bestDist = Infinity;
    for (let y = 1; y < grid.rows - 1; y++) {
      for (let x = 1; x < grid.cols - 1; x++) {
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < bestDist && this._fits(x, y, grid, player, foes)) {
          bestDist = d;
          best = { x, y };
        }
      }
    }
    best ||= grid.nearestEmpty(cx, cy);
    return best ? this._place(type, best.x, best.y) : null;
  }

  /** The level's new power if it is still owed, else a weighted draw from the pool (without life unless `lifeOk`). */
  _pick(lifeOk = true) {
    const pool = lifeOk ? this._pool : this._pool.filter((type) => type !== 'life');
    if (!pool.length) return null;
    if (pool.includes(this._first)) return this._first;
    const weight = (type) => (type === 'life' ? LIFE_WEIGHT : 1);
    let roll = this.rng() * pool.reduce((sum, type) => sum + weight(type), 0);
    for (const type of pool) {
      roll -= weight(type);
      if (roll < 0) return type;
    }
    return pool[pool.length - 1];
  }

  /** A `type` pick-up on a random qualifying cell, or null when SPAWN_TRIES found none. */
  _scatter(type, grid, player, foes) {
    for (let t = 0; t < SPAWN_TRIES; t++) {
      const x = 1 + Math.floor(this.rng() * (grid.cols - 2));
      const y = 1 + Math.floor(this.rng() * (grid.rows - 2));
      if (this._fits(x, y, grid, player, foes)) return this._place(type, x, y);
    }
    return null;
  }

  /** Open cell, well clear of land, of every foe and of the arrowhead. */
  _fits(x, y, grid, player, foes) {
    if (!grid.isEmpty(x, y)) return false;
    for (let dy = -LAND_GAP; dy <= LAND_GAP; dy++) {
      for (let dx = -LAND_GAP; dx <= LAND_GAP; dx++) if (grid.isSolid(x + dx, y + dy)) return false;
    }
    if ((x - player.x) ** 2 + (y - player.y) ** 2 < PLAYER_GAP * PLAYER_GAP) return false;
    for (const foe of foes) {
      if (foe.alive && (x - foe.x) ** 2 + (y - foe.y) ** 2 < FOE_GAP * FOE_GAP) return false;
    }
    return true;
  }

  _place(type, x, y) {
    const pickup = { type, x, y, age: 0, life: TUNING.pickupLife, alive: true };
    this.pickups.push(pickup);
    return pickup;
  }
}
