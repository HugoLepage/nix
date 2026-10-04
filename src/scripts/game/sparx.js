import { DIR_NAMES, DIRS, SOLID } from '../config.js';

const STEPS = DIR_NAMES.map((name) => DIRS[name]);
// Hand-on-wall preference in quarter turns toward the hand: hand side, straight, away, back.
const TURNS = [1, 0, -1, 2];
// When the heading has to be re-seated, disturb it as little as possible.
const RESEAT = [0, 1, -1, 2];

const turned = (d, quarterTurns) => (d + quarterTurns + 4) & 3;

/**
 * Rail crawler. It is a wall follower whose "wall" is the open field: a
 * clockwise sparx keeps the field on its right hand, so it laps the rail
 * clockwise on screen. The walk is only sound while that hand actually touches
 * open space, so the heading is re-seated whenever a capture breaks the contact.
 */
export class Sparx {
  constructor(grid, { x, y, clockwise = true, speed }) {
    // Anything that is not a cell of land falls back to the usual bottom spawn.
    const start = grid.inBounds(x, y) && grid.isSolid(x, y) ? { x, y } : grid.spawnCell('bottom');
    this.grid = grid;
    this.cell = start;
    this.x = start.x;
    this.y = start.y;
    this.clockwise = clockwise;
    this.speed = speed;
    this.alive = true;
    this.homing = false;
    this.phase = 0;
    this._heading = -1; // index into DIR_NAMES, -1 while standing still
    this._target = null;
    this._progress = 0;
    this._path = null;
    this._pathIndex = 0;
  }

  get dir() {
    return this._heading < 0 ? null : DIR_NAMES[this._heading];
  }

  /** `player` (optional) only matters when rejoining the rail after being buried. */
  update(dt, player = null) {
    if (!this.alive || !(dt > 0)) return;
    this.phase += dt;

    let remaining = this.speed * dt;
    while (remaining > 0) {
      if (!this._target && !this._depart(player)) break;
      const left = 1 - this._progress;
      if (remaining < left) {
        this._progress += remaining;
        break;
      }
      remaining -= left;
      this.cell = this._target;
      this._target = null;
      this._progress = 0;
    }

    const step = this._target ? STEPS[this._heading] : null;
    this.x = this.cell.x + (step ? step.x * this._progress : 0);
    this.y = this.cell.y + (step ? step.y * this._progress : 0);
  }

  /**
   * Call after every capture. Everything else is re-evaluated at the next cell
   * centre; only a homing route has to be dropped because its goal may be buried now.
   */
  onGridChanged() {
    this._path = null;
  }

  _depart(player) {
    const { grid, cell } = this;
    if (!grid.isFrontier(cell.x, cell.y)) return this._home();
    if (this.homing) this._rejoin(player);

    const hand = this.clockwise ? 1 : -1;
    const heading = this._seat(hand);
    const move = heading < 0 ? -1 : this._next(heading, hand);
    if (move < 0) {
      this._heading = -1; // nowhere to go yet: stand still and ask again next frame
      return false;
    }
    this._go(move);
    return true;
  }

  _go(d) {
    this._heading = d;
    this._target = { x: this.cell.x + STEPS[d].x, y: this.cell.y + STEPS[d].y };
  }

  /** Walks captured land toward the rail. */
  _home() {
    if (!this._path || this._pathIndex >= this._path.length) {
      this._path = this.grid.pathToFrontier(this.cell.x, this.cell.y);
      this._pathIndex = 0;
    }
    const next = this._path[this._pathIndex++];
    if (!next) {
      this._path = null;
      this.homing = false;
      this._heading = -1;
      return false;
    }
    this.homing = true;
    this._go(STEPS.findIndex((s) => s.x === next.x - this.cell.x && s.y === next.y - this.cell.y));
    return true;
  }

  /** Back on the rail: lap it in whichever sense starts out toward the player. */
  _rejoin(player) {
    this.homing = false;
    this._path = null;
    if (!player) return;
    const own = this.clockwise ? 1 : -1;
    let best = Infinity;
    for (const hand of [own, -own]) {
      const heading = this._seat(hand);
      const move = heading < 0 ? -1 : this._next(heading, hand);
      if (move < 0) continue;
      const dx = this.cell.x + STEPS[move].x - player.x;
      const dy = this.cell.y + STEPS[move].y - player.y;
      const dist = dx * dx + dy * dy;
      if (dist < best) {
        best = dist;
        this.clockwise = hand === 1;
      }
    }
  }

  /** The hand rule: first of [hand, straight, away, back] that stays on the rail, or -1. */
  _next(heading, hand) {
    const { grid, cell } = this;
    for (const t of TURNS) {
      const d = turned(heading, t * hand);
      if (grid.isFrontier(cell.x + STEPS[d].x, cell.y + STEPS[d].y)) return d;
    }
    return -1;
  }

  /** Current heading if its hand still touches the field, else the nearest heading that does (-1: none). */
  _seat(hand) {
    const from = Math.max(this._heading, 0);
    for (const t of RESEAT) {
      const d = turned(from, t * hand);
      if (this._touches(d, hand)) return d;
    }
    return -1;
  }

  /** Open space beside the hand or just behind it (the state right before a turn round a corner). */
  _touches(heading, hand) {
    const side = STEPS[turned(heading, hand)];
    const ahead = STEPS[heading];
    const hx = this.cell.x + side.x;
    const hy = this.cell.y + side.y;
    return this.grid.get(hx, hy) !== SOLID || this.grid.get(hx - ahead.x, hy - ahead.y) !== SOLID;
  }
}
