import { SOLID, TRAIL } from '../config.js';

const TAU = Math.PI * 2;
const MAX_STEP = 0.25; // cells per collision sub-step: too short to tunnel through a 1-cell wall
const MAX_TURN = 4.5; // rad / s, reached only by the rare sharp swerve
const TURN_EASE = 5; // 1 / s
const SURGE_MIN = 0.6;
const SURGE_MAX = 1.6;
const SURGE_EASE = 2.5; // 1 / s
const BOUNCE_JITTER = 0.6; // rad, either way
const ESCAPE_SPEED = 14; // cells / s while gliding out of land that closed over it

const wrap = (a) => a - TAU * Math.round(a / TAU);

/**
 * Free-roaming enemy: a circle that bounces off SOLID cells and drifts through
 * everything else. All randomness comes from `rng`, so a seeded generator
 * replays the exact same flight.
 */
export class Qix {
  constructor(grid, { x = (grid.cols - 1) / 2, y = (grid.rows - 1) / 2, speed, radius, rng = Math.random }) {
    this.grid = grid;
    this.x = x;
    this.y = y;
    this.speed = speed;
    this.radius = radius;
    this.rng = rng;
    this.alive = true;
    this.phase = 0;
    this.heading = rng() * TAU - Math.PI;
    this.vx = Math.cos(this.heading) * speed;
    this.vy = Math.sin(this.heading) * speed;
    this._turn = 0;
    this._turnTarget = 0;
    this._turnTimer = 0;
    this._surge = 1;
    this._surgeTarget = 1;
    this._surgeTimer = 0;
    this._escape = null;
  }

  get cell() {
    return { x: Math.round(this.x), y: Math.round(this.y) };
  }

  update(dt) {
    if (!this.alive || !(dt > 0)) return;
    this.phase += dt;
    if (this._overlaps(this.x, this.y, SOLID)) {
      this._unstick(dt);
      return;
    }
    this._escape = null;
    this._wander(dt);

    const v = this.speed * this._surge;
    this.vx = Math.cos(this.heading) * v;
    this.vy = Math.sin(this.heading) * v;
    const steps = Math.max(1, Math.ceil((v * dt) / MAX_STEP));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const nx = this.x + this.vx * h;
      const hitX = this._overlaps(nx, this.y, SOLID);
      if (hitX) this.vx = -this.vx;
      else this.x = nx;
      const ny = this.y + this.vy * h;
      const hitY = this._overlaps(this.x, ny, SOLID);
      if (hitY) this.vy = -this.vy;
      else this.y = ny;
      if (hitX || hitY) this._deflect(hitX, hitY);
    }
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

  /** Smooth random steering plus slow speed surges. */
  _wander(dt) {
    const { rng } = this;
    this._turnTimer -= dt;
    if (this._turnTimer <= 0) {
      // Cubed so it mostly sweeps in long arcs and only now and then whips round.
      this._turnTarget = (rng() * 2 - 1) ** 3 * MAX_TURN;
      this._turnTimer = 0.2 + rng() * 0.9;
    }
    this._surgeTimer -= dt;
    if (this._surgeTimer <= 0) {
      this._surgeTarget = SURGE_MIN + rng() * (SURGE_MAX - SURGE_MIN);
      this._surgeTimer = 0.4 + rng() * 1.2;
    }
    this._turn += (this._turnTarget - this._turn) * (1 - Math.exp(-TURN_EASE * dt));
    this._surge += (this._surgeTarget - this._surge) * (1 - Math.exp(-SURGE_EASE * dt));
    this.heading = wrap(this.heading + this._turn * dt);
  }

  /** Roughens a reflection, but never so far that it steers back into the wall it just left. */
  _deflect(hitX, hitY) {
    const a = (this.rng() * 2 - 1) * BOUNCE_JITTER;
    const vx = this.vx * Math.cos(a) - this.vy * Math.sin(a);
    const vy = this.vx * Math.sin(a) + this.vy * Math.cos(a);
    if (!(hitX && vx * this.vx <= 0) && !(hitY && vy * this.vy <= 0)) {
      this.vx = vx;
      this.vy = vy;
    }
    this.heading = Math.atan2(this.vy, this.vx);
  }

  /** Circle against the unit squares of every cell in `state` (out of bounds reads as SOLID). */
  _overlaps(x, y, state) {
    const { grid, radius } = this;
    const r2 = radius * radius;
    const x0 = Math.round(x - radius);
    const x1 = Math.round(x + radius);
    const y1 = Math.round(y + radius);
    for (let cy = Math.round(y - radius); cy <= y1; cy++) {
      const dy = y - Math.max(cy - 0.5, Math.min(cy + 0.5, y));
      for (let cx = x0; cx <= x1; cx++) {
        if (grid.get(cx, cy) !== state) continue;
        const dx = x - Math.max(cx - 0.5, Math.min(cx + 0.5, x));
        if (dx * dx + dy * dy < r2) return true;
      }
    }
    return false;
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
    this.heading = Math.atan2(dy, dx);
    this.vx = (dx / dist) * this.speed;
    this.vy = (dy / dist) * this.speed;
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
    this._escape = { spot: spot || grid.nearestEmpty(this.x, this.y), version: grid.version };
    return this._escape.spot;
  }
}
