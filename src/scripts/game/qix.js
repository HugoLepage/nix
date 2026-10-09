import { SOLID, TRAIL, TUNING } from '../config.js';

export const TAU = Math.PI * 2;
const QUARTER = Math.PI / 2;
const MIN_TILT = Math.PI / 9; // 20°: the least a straight flier's heading leans off either axis
const MAX_STEP = 0.25; // cells per collision sub-step: too short to tunnel through a 1-cell wall
const ESCAPE_SPEED = 14; // cells / s while gliding out of land that closed over it
const NO_WORLD = { player: null, liveQix: 0 };

/** Wraps an angle into [-PI, PI]. */
export const wrap = (a) => a - TAU * Math.round(a / TAU);

/**
 * `angle` turned by the least amount that leaves it at least 20° off both axes. A mirror bounce keeps that lean,
 * so a straight flier never settles into a dull horizontal or vertical shuttle.
 */
export function tilted(angle) {
  const lean = angle - QUARTER * Math.floor(angle / QUARTER); // 0 .. QUARTER
  if (lean < MIN_TILT) return wrap(angle + (MIN_TILT - lean));
  if (lean > QUARTER - MIN_TILT) return wrap(angle - (lean - (QUARTER - MIN_TILT)));
  return wrap(angle);
}

/** Uniformly random among the headings at least 20° off both axes. */
export function randomHeading(rng) {
  return wrap(Math.floor(rng() * 4) * QUARTER + MIN_TILT + rng() * (QUARTER - 2 * MIN_TILT));
}

/**
 * Circle against the unit squares of every cell in `state` (out of bounds reads as SOLID). Without `out` it stops
 * at the first overlap; with it, it finds the deepest overlapping cell and writes it ({x, y}) and the contact point
 * on that cell's square ({px, py}) into `out`.
 */
export function circleHits(grid, x, y, radius, state, out = null) {
  let best = radius * radius;
  let found = false;
  const x0 = Math.round(x - radius);
  const x1 = Math.round(x + radius);
  const y1 = Math.round(y + radius);
  for (let cy = Math.round(y - radius); cy <= y1; cy++) {
    const py = Math.max(cy - 0.5, Math.min(cy + 0.5, y));
    const dy = y - py;
    for (let cx = x0; cx <= x1; cx++) {
      if (grid.get(cx, cy) !== state) continue;
      const px = Math.max(cx - 0.5, Math.min(cx + 0.5, x));
      const dx = x - px;
      const d = dx * dx + dy * dy;
      if (d >= best) continue;
      if (!out) return true;
      best = d;
      found = true;
      out.x = cx;
      out.y = cy;
      out.px = px;
      out.py = py;
    }
  }
  return found;
}

/**
 * Free-flying enemy: a circle (`radius` is the whole hitbox) that flies dead straight at `speed`, mirrors off
 * SOLID cells one axis at a time and drifts through everything else. Kinds that steer or keep timers override
 * `_think`; kinds that react to their bounces override `_bounced`. All randomness comes from `rng`, so a seeded
 * generator replays the exact same flight. `phase` is the foe's own clock: the game hands every foe scaled time,
 * so it stops under time stop and crawls under slow-mo.
 */
export class Foe {
  constructor(grid, {
    kind,
    speed,
    radius,
    heading, // radians; random (and well off the axes) when left out
    rng = Math.random,
    x = (grid.cols - 1) / 2,
    y = (grid.rows - 1) / 2,
  }) {
    this.grid = grid;
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.speed = speed;
    this.radius = radius;
    this.slack = TUNING.qixHitSlack; // reach past the body that still catches the arrowhead
    this.rng = rng;
    this.alive = true;
    this.phase = 0;
    this._events = [];
    this._escape = null;
    this.aim(heading ?? randomHeading(rng));
  }

  get cell() {
    return { x: Math.round(this.x), y: Math.round(this.y) };
  }

  /** Points the velocity along `angle` at the current speed. */
  aim(angle) {
    this.heading = angle;
    this.vx = Math.cos(angle) * this.speed;
    this.vy = Math.sin(angle) * this.speed;
  }

  /**
   * Advances by dt seconds of the foe's own clock. `world` = { player, liveQix } is what a foe may react to.
   * Returns the events that happened ({type: 'impact', x, y, regionId}, {type: 'launch'}), in an array that is
   * reused by the next update (it runs several times a frame), so consume it right away.
   */
  update(dt, world = NO_WORLD) {
    const events = this._events;
    events.length = 0;
    if (!this.alive || !(dt > 0)) return events;
    this.phase += dt;
    if (this._overlaps(this.x, this.y, SOLID)) {
      this._unstick(dt);
      return events;
    }
    // Free again after a glide out of fresh land: fly on from there, leaning off the axes like any launch.
    if (this._escape) {
      this._escape = null;
      this.aim(tilted(this.heading));
    }
    this._think(dt, world, events);
    this._fly(dt, events);
    return events;
  }

  hitsTrail() {
    return this.grid.trail.length > 0 && this._overlaps(this.x, this.y, TRAIL);
  }

  hitsPoint(px, py, extra = 0) {
    const reach = this.radius + extra;
    const dx = px - this.x;
    const dy = py - this.y;
    return dx * dx + dy * dy < reach * reach;
  }

  /** Whether the body (plus its slack) reaches the arrowhead's centre. */
  hitsShip(player) {
    return this.hitsPoint(player.x, player.y, this.slack);
  }

  /** Per-kind steering and timers, run each update before the move. */
  _think() {}

  /** Per-kind reaction to a bounce off the land overlapping the circle at (x, y). */
  _bounced() {}

  /** Straight flight in short sub-steps: a blocked axis mirrors its velocity and holds still for that sub-step. */
  _fly(dt, events) {
    const steps = Math.max(1, Math.ceil((this.speed * dt) / MAX_STEP));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const nx = this.x + this.vx * h;
      const hitX = this._overlaps(nx, this.y, SOLID);
      if (hitX) {
        this.vx = -this.vx;
        this._bounced(nx, this.y, events);
      } else {
        this.x = nx;
      }
      const ny = this.y + this.vy * h;
      const hitY = this._overlaps(this.x, ny, SOLID);
      if (hitY) {
        this.vy = -this.vy;
        this._bounced(this.x, ny, events);
      } else {
        this.y = ny;
      }
      if (hitX || hitY) this.heading = Math.atan2(this.vy, this.vx);
    }
  }

  _overlaps(x, y, state, out = null) {
    return circleHits(this.grid, x, y, this.radius, state, out);
  }

  /** A capture closed over part of the circle: glide to the nearest spot with room, ignoring walls. */
  _unstick(dt) {
    const spot = this._escapeSpot();
    if (!spot) return;
    const dx = spot.x - this.x;
    const dy = spot.y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return; // already as free as the board allows
    const reach = Math.min(1, (ESCAPE_SPEED * dt) / dist); // share of the way covered this frame
    const steps = Math.ceil((dist * reach) / MAX_STEP);
    const x0 = this.x;
    const y0 = this.y;
    for (let i = 1; i <= steps; i++) {
      const t = (reach * i) / steps;
      // Land on the spot exactly: a rounding error there could read as an overlap for ever.
      this.x = t === 1 ? spot.x : x0 + dx * t;
      this.y = t === 1 ? spot.y : y0 + dy * t;
      if (!this._overlaps(this.x, this.y, SOLID)) break;
    }
    this.aim(Math.atan2(dy, dx));
  }

  /** Nearest half-cell lattice point where the whole circle fits; kept until the board changes. */
  _escapeSpot() {
    const { grid } = this;
    if (this._escape && this._escape.version === grid.version) return this._escape.spot;
    let spot = null;
    let best = Infinity;
    for (let cy = 1; cy <= grid.rows - 2; cy += 0.5) {
      for (let cx = 1; cx <= grid.cols - 2; cx += 0.5) {
        const d = (cx - this.x) ** 2 + (cy - this.y) ** 2;
        if (d < best && !this._overlaps(cx, cy, SOLID)) {
          best = d;
          spot = { x: cx, y: cy };
        }
      }
    }
    // No pocket is wide enough any more: settle on the closest open cell.
    this._escape = { spot: spot || this.grid.nearestEmpty(this.x, this.y), version: grid.version };
    return this._escape.spot;
  }
}

/** The classic foe: a plasma orb that flies dead straight and only ever turns by bouncing off land. */
export class Qix extends Foe {
  constructor(grid, { speed = TUNING.qixSpeed, radius = TUNING.qixRadius, ...options } = {}) {
    super(grid, { ...options, kind: 'qix', speed, radius });
  }
}
