import { DIRS, EMPTY, TRAIL, TUNING } from '../config.js';

const TAU = Math.PI * 2;
const ANGLES = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };
const OPPOSITE = { up: 'down', right: 'left', down: 'up', left: 'right' };
// Exponential ease of the arrowhead toward its facing: ~90 % of any turn is done in 90 ms.
const TURN_RATE = 26;

/** Wraps an angle into [-PI, PI]. */
const wrap = (a) => a - TAU * Math.round(a / TAU);

/**
 * The arrowhead. Moves cell to cell at constant speed and only ever decides
 * where to go at a cell centre, so it can never leave the lattice.
 * `cell` is the last centre it reached, `target` the one it is heading for
 * (null at rest). `invuln` is granted by the game and counted down here.
 */
export class Player {
  constructor(grid, { speed = TUNING.playerSpeed } = {}) {
    this.grid = grid;
    this.speed = speed;
    this.invuln = 0;
    this._events = [];
    this.spawn(grid.spawnCell('top'));
  }

  get moving() {
    return this.dir !== null;
  }

  /** Drawing inside a pocket of its own trail that touches no land: no move can ever capture again. */
  get trapped() {
    return this.alive && this.drawing && this._sealed;
  }

  spawn(cell) {
    this.cell = { x: cell.x, y: cell.y };
    this.target = null;
    this._progress = 0; // 0..1 of the way from cell to target
    this.x = cell.x;
    this.y = cell.y;
    this.dir = null;
    this.want = null;
    this.facing = 'down';
    this.angle = ANGLES.down;
    this.drawing = false;
    this.alive = true;
    this._sealed = false;
  }

  setWanted(name) {
    if (DIRS[name]) this.want = name;
  }

  kill() {
    this.alive = false;
    this.dir = null;
    this.want = null;
    this.drawing = false;
    this.cell = { x: Math.round(this.x), y: Math.round(this.y) };
    this.target = null;
    this._progress = 0;
  }

  /**
   * Advances by dt seconds (also counts `invuln` down). Returns the events that happened, in order, in an
   * array that is reused by the next update (it runs several times a frame), so consume it right away.
   */
  update(dt) {
    const events = this._events;
    events.length = 0;
    if (!this.alive || !(dt > 0)) return events;
    this.invuln = Math.max(0, this.invuln - dt);
    // On the rail a U-turn is instant, Pac-Man style. Out in the field the cell behind is our own trail.
    if (this.target && !this.drawing && this.want === OPPOSITE[this.dir] && this._legal(this.want, this.target)) this._reverse();

    let remaining = this.speed * dt;
    while (remaining > 0) {
      if (!this.target && !this._depart(events)) break;
      const left = 1 - this._progress;
      if (remaining < left) {
        this._progress += remaining;
        break;
      }
      remaining -= left;
      this._arrive(events);
    }

    const step = this.target ? DIRS[this.dir] : null;
    this.x = this.cell.x + (step ? step.x * this._progress : 0);
    this.y = this.cell.y + (step ? step.y * this._progress : 0);
    const turn = wrap(ANGLES[this.facing] - this.angle);
    this.angle = wrap(this.angle + turn * (1 - Math.exp(-TURN_RATE * dt)));
    return events;
  }

  /** Whether a step `name` from `cell` (default: the last centre reached) follows the movement rules. */
  _legal(name, cell = this.cell) {
    if (!name) return false;
    const { grid } = this;
    const bx = cell.x + DIRS[name].x;
    const by = cell.y + DIRS[name].y;
    if (!grid.inBounds(bx, by)) return false;
    const state = grid.get(bx, by);
    if (state === TRAIL) return false;
    if (state === EMPTY || this.drawing) return true;
    // Out of captured land when a capture has buried us: any way out will do.
    if (!grid.isFrontier(cell.x, cell.y)) return true;
    if (!grid.isFrontier(bx, by)) return false;
    // Rail to rail, but only along links the rail draws (Grid.railSegments): one of the four cells beside it is open.
    const px = DIRS[name].y;
    const py = DIRS[name].x;
    return !grid.isSolid(cell.x + px, cell.y + py) || !grid.isSolid(cell.x - px, cell.y - py) ||
      !grid.isSolid(bx + px, by + py) || !grid.isSolid(bx - px, by - py);
  }

  /** Picks a direction at a cell centre and commits to the next cell. */
  _depart(events) {
    const name = this._legal(this.want) ? this.want : this._legal(this.dir) ? this.dir : null;
    if (!name) {
      if (this.dir) {
        this.dir = null;
        events.push({ type: 'stopped' });
      }
      return false;
    }
    const { grid, cell } = this;
    const target = { x: cell.x + DIRS[name].x, y: cell.y + DIRS[name].y };
    if (grid.isEmpty(target.x, target.y)) {
      if (!this.drawing) {
        this.drawing = true;
        grid.beginTrail(cell.x, cell.y);
        events.push({ type: 'trailStart', x: cell.x, y: cell.y });
      }
      // Claimed on departure so the qix can cut the line the instant we commit to it.
      grid.addTrail(target.x, target.y);
      events.push({ type: 'trailCell', x: target.x, y: target.y });
      // Only a new trail cell can close the last way back to land.
      this._sealed = !grid.reachesLand(target.x, target.y);
    }
    this.dir = name;
    this.facing = name;
    this.target = target;
    return true;
  }

  /** Turns round between two rail cells without visiting a centre first. */
  _reverse() {
    const from = this.cell;
    this.cell = this.target;
    this.target = from;
    this._progress = 1 - this._progress;
    this.dir = this.want;
    this.facing = this.want;
  }

  _arrive(events) {
    this.cell = this.target;
    this.target = null;
    this._progress = 0;
    if (this.drawing && this.grid.isSolid(this.cell.x, this.cell.y)) {
      this.drawing = false;
      const result = this.grid.capture();
      if (result) events.push({ type: 'capture', result });
      // The capture buried the arrival cell: no rail here, so wait for a fresh direction instead of tunnelling on.
      if (!this.grid.isFrontier(this.cell.x, this.cell.y)) this.dir = this.want = null;
    }
  }
}
