import { DIR_NAMES, DIRS, EMPTY, TRAIL, TUNING } from '../config.js';

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
 * (null at rest). `moved` turns true at the first move after a spawn: the sparx wait for it, and so does the
 * countdown of `invuln` (granted by the game), so a respawn blink never runs out on a ship that has not moved.
 * The game sets `boost` (speed multiplier) and `cutArmed` (instant cut) from the running powers.
 */
export class Player {
  constructor(grid, { speed = TUNING.playerSpeed } = {}) {
    this.grid = grid;
    this.speed = speed;
    this.boost = 1;
    this.cutArmed = false;
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
    this.moved = false;
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
   * Advances by dt seconds (also counts `invuln` down once the arrowhead has moved). Returns the events that
   * happened, in order, in an array that is reused by the next update (it runs several times a frame), so consume
   * it right away.
   */
  update(dt) {
    const events = this._events;
    events.length = 0;
    if (!this.alive || !(dt > 0)) return events;
    // Held until the first move, like the sparx: a respawn on top of a parked sparx keeps its full blink to get clear.
    if (this.moved) this.invuln = Math.max(0, this.invuln - dt);
    // Armed while drawing but stuck at a centre (its own trail in the way): no arrival is coming, so cut from here.
    if (this.cutArmed && this.drawing && !this.target) this._cut(events);
    // On the rail a U-turn is instant, Pac-Man style. Out in the field the cell behind is our own trail.
    if (this.target && !this.drawing && this.want === OPPOSITE[this.dir] && this._legal(this.want, this.target)) this._reverse();

    let remaining = this.speed * this.boost * dt;
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
    this.moved = true;
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
    if (!this.drawing) return;
    if (this.grid.isSolid(this.cell.x, this.cell.y)) {
      this.drawing = false;
      const result = this.grid.capture();
      if (result) events.push({ type: 'capture', result });
      // The capture buried the arrival cell: no rail here, so wait for a fresh direction instead of tunnelling on.
      if (!this.grid.isFrontier(this.cell.x, this.cell.y)) this.dir = this.want = null;
    } else if (this.cutArmed) {
      this._cut(events);
    }
  }

  /**
   * Instant cut: rules the line on straight ahead (at rest: the way with the shortest run to land) through open
   * field up to land or the trail, and closes it at once. The arrowhead stays where it is and stops.
   * Emits {type: 'cut', cells} (the cells it drew, outward from the arrowhead) before the capture.
   */
  _cut(events) {
    const { grid, cell } = this;
    const { x: dx, y: dy } = DIRS[this.dir || this._cutDirection()];
    const cells = [];
    for (let x = cell.x + dx, y = cell.y + dy; grid.isEmpty(x, y); x += dx, y += dy) cells.push({ x, y });
    for (const c of cells) grid.addTrail(c.x, c.y);
    this.cutArmed = false;
    this.drawing = false;
    this._sealed = false;
    this.dir = this.want = null;
    events.push({ type: 'cut', cells });
    const result = grid.capture();
    if (result) events.push({ type: 'capture', result });
  }

  /** The way whose straight run of open field is shortest, runs that end on land before those that end on trail. */
  _cutDirection() {
    const { grid, cell } = this;
    let best = DIR_NAMES[0];
    let bestScore = Infinity;
    for (const name of DIR_NAMES) {
      const step = DIRS[name];
      let x = cell.x + step.x;
      let y = cell.y + step.y;
      let run = 0;
      while (grid.isEmpty(x, y)) {
        x += step.x;
        y += step.y;
        run++;
      }
      const score = run + (grid.isSolid(x, y) ? 0 : grid.size);
      if (score < bestScore) {
        bestScore = score;
        best = name;
      }
    }
    return best;
  }

  /**
   * Land under the line vanished (a chipper shattered a region) while drawing: a target that was land is open
   * field now and joins the trail like any other step, and the seal check is redone from the head of the line.
   */
  onGridChanged() {
    if (!this.alive || !this.drawing) return;
    const { grid } = this;
    const head = this.target || this.cell;
    if (this.target && grid.isEmpty(head.x, head.y)) grid.addTrail(head.x, head.y);
    this._sealed = !grid.reachesLand(head.x, head.y);
  }
}
