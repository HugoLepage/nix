import { SOLID, TUNING } from '../config.js';
import { circleHits, Foe, Qix, TAU, tilted, wrap } from './qix.js';

const CHIPPER_SPIN = 2.6; // rad / s; the sense flips with every bounce, so each impact visibly kicks it
const SPAWNER_SPIN = 0.5; // rad / s
const WALL_GAP = 1; // cells of open field between a foe's starting circle and any land
const PLAYER_GAP = 10; // cells from the player's spawn to any foe's starting centre
const CENTRE_JITTER = 2; // cells the first foe may start off the exact middle
const START_TRIES = 48;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Spiky qix that wears captured land down. Each bounce reports an impact with the region it struck (0 = the outer
 * wall); the game counts them per region and shatters a region at `chipperHits`. One bounce is one impact, however
 * many sub-steps graze the wall: impacts closer together than `chipperHitCooldown` are dropped.
 */
export class Chipper extends Foe {
  constructor(grid, { speed = TUNING.chipperSpeed, radius = TUNING.chipperRadius, ...options } = {}) {
    super(grid, { ...options, kind: 'chipper', speed, radius });
    this.spin = 0;
    this._cooldown = 0;
    this._contact = { x: 0, y: 0, px: 0, py: 0 };
  }

  _think(dt) {
    this._cooldown = Math.max(0, this._cooldown - dt);
    this.spin = wrap(this.spin + (this.vx * this.vy < 0 ? -CHIPPER_SPIN : CHIPPER_SPIN) * dt);
  }

  _bounced(x, y, events) {
    if (this._cooldown > 0) return;
    const hit = this._contact;
    if (!this._overlaps(x, y, SOLID, hit)) return;
    const { grid } = this;
    const regionId = grid.inBounds(hit.x, hit.y) ? grid.region[grid.idx(hit.x, hit.y)] : 0;
    events.push({ type: 'impact', x: hit.px, y: hit.py, regionId });
    this._cooldown = TUNING.chipperHitCooldown;
  }
}

/**
 * Heat seeker: dozes along at cruise speed, bouncing like a qix, until the player leaves the rail. Then it locks
 * on, speeds up toward `seekerMax` and steers after the arrowhead at a limited turn rate; once the player is safe
 * on the rail again it lets go, keeps its heading and coasts back down to cruise. It only ever hunts the
 * arrowhead: the trail does not stop it and it does not cut the trail.
 */
export class Seeker extends Foe {
  constructor(grid, { speed = TUNING.seekerCruise, radius = TUNING.seekerRadius, ...options } = {}) {
    super(grid, { ...options, kind: 'seeker', speed, radius });
    this.cruise = speed;
    this.slack = TUNING.seekerHitSlack;
    this.locked = false;
    this.boost = 0; // 0..1 of the way from cruise to full chase
  }

  hitsTrail() {
    return false;
  }

  _think(dt, { player }) {
    const { seekerMax, seekerAccel, seekerDecel, seekerTurn } = TUNING;
    this.locked = Boolean(player && player.alive && player.drawing);
    let { heading } = this;
    if (this.locked) {
      this.speed = Math.min(seekerMax, this.speed + seekerAccel * dt);
      const turn = wrap(Math.atan2(player.y - this.y, player.x - this.x) - heading);
      const limit = seekerTurn * dt;
      heading = wrap(heading + Math.max(-limit, Math.min(limit, turn)));
    } else {
      this.speed = Math.max(this.cruise, this.speed - seekerDecel * dt);
    }
    this.boost = clamp01((this.speed - this.cruise) / (seekerMax - this.cruise));
    this.aim(heading);
  }
}

/**
 * Mother ship: a big, slow sphere that bounces like a qix and every `interval` seconds of its own clock (the first
 * time after `first`) fires a fresh qix out of port `nextPort`. While `maxQix` qix (from anywhere) are loose it
 * holds its fire fully charged and lets go as soon as one of them is gone. The game performs the launch it
 * announces: `launch()` builds the qix, `turnPort()` then moves on to the next port.
 */
export class Spawner extends Foe {
  constructor(grid, {
    speed = TUNING.spawnerSpeed,
    radius = TUNING.spawnerRadius,
    ports = TUNING.spawnerPorts,
    first = TUNING.spawnerFirst,
    interval = TUNING.spawnerInterval,
    maxQix = TUNING.spawnerMaxQix,
    ...options
  } = {}) {
    super(grid, { ...options, kind: 'spawner', speed, radius });
    this.ports = ports;
    this.interval = interval;
    this.maxQix = maxQix;
    this.spin = this.rng() * TAU;
    this.charge = 0; // 0..1 toward the next launch
    this.nextPort = 0;
    this._period = first;
    this._wait = first;
  }

  _think(dt, { liveQix }, events) {
    this.spin = wrap(this.spin + SPAWNER_SPIN * dt);
    this._wait = Math.max(0, this._wait - dt);
    this.charge = this._period > 0 ? 1 - this._wait / this._period : 1;
    if (this._wait > 0 || liveQix >= this.maxQix) return;
    events.push({ type: 'launch' });
    this._period = this._wait = this.interval;
    this.charge = 0;
  }

  /** The qix of the launch just announced: from the centre, out along port `nextPort` (leaning off the axes). */
  launch() {
    const angle = this.spin + (this.nextPort * TAU) / this.ports;
    return new Qix(this.grid, { x: this.x, y: this.y, heading: tilted(angle), rng: this.rng });
  }

  turnPort() {
    this.nextPort = (this.nextPort + 1) % this.ports;
  }
}

const KINDS = { qix: Qix, chipper: Chipper, seeker: Seeker, spawner: Spawner };

/** The foe a level entry `{ kind, ...overrides }` describes; TUNING fills in whatever it leaves out. */
export function createFoe(grid, { kind, ...overrides }, rng = Math.random) {
  const Kind = KINDS[kind];
  if (!Kind) throw new RangeError(`Unknown foe kind ${kind}`);
  return new Kind(grid, { rng, ...overrides });
}

/**
 * Spreads `foes` over the open field before play: every circle at least WALL_GAP clear of land, every centre at
 * least PLAYER_GAP from `avoid` (the player's spawn). The first starts near the middle, as the lone qix always
 * has; each later one takes the best of a few random spots, the one leaving the most room to those placed before.
 */
export function placeFoes(grid, foes, avoid, rng = Math.random) {
  const placed = [];
  const fits = (x, y, radius) =>
    Math.hypot(x - avoid.x, y - avoid.y) >= PLAYER_GAP && !circleHits(grid, x, y, radius + WALL_GAP, SOLID);
  for (const foe of foes) {
    let spot = null;
    if (!placed.length) {
      const x = (grid.cols - 1) / 2 + (rng() * 2 - 1) * CENTRE_JITTER;
      const y = (grid.rows - 1) / 2 + (rng() * 2 - 1) * CENTRE_JITTER;
      if (fits(x, y, foe.radius)) spot = { x, y };
    }
    spot ||= roomiest(grid, placed, foe.radius, fits, rng);
    // A board too small for the rules: the middle will have to do.
    foe.x = spot ? spot.x : (grid.cols - 1) / 2;
    foe.y = spot ? spot.y : (grid.rows - 1) / 2;
    placed.push(foe);
  }
}

/** Best of START_TRIES random spots where `fits` holds: the one leaving the most room to the foes in `placed`. */
function roomiest(grid, placed, radius, fits, rng) {
  // Interior cells span 0.5 .. size - 1.5 in board space.
  const margin = 0.5 + radius + WALL_GAP;
  const spanX = Math.max(0, grid.cols - 1 - 2 * margin);
  const spanY = Math.max(0, grid.rows - 1 - 2 * margin);
  let spot = null;
  let room = -Infinity;
  for (let t = 0; t < START_TRIES; t++) {
    const x = margin + rng() * spanX;
    const y = margin + rng() * spanY;
    if (!fits(x, y, radius)) continue;
    let free = Infinity;
    for (const p of placed) free = Math.min(free, Math.hypot(x - p.x, y - p.y) - p.radius - radius);
    if (free > room) {
      room = free;
      spot = { x, y };
    }
  }
  return spot;
}
