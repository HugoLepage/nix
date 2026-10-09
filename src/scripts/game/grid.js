import { EMPTY, SOLID, TRAIL } from '../config.js';

const NX = [1, -1, 0, 0];
const NY = [0, 0, 1, -1];

/**
 * The board. Cell (x, y) is a unit square centred on (x, y) in board space.
 * The outer ring starts SOLID; everything the player captures becomes SOLID,
 * tagged with its capture's region id so a chipper can later shatter it back.
 * The "frontier" is every SOLID cell touching (8-way) a non-SOLID cell: it is
 * the rail the player and the sparx travel on.
 */
export class Grid {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.size = cols * rows;
    this.cells = new Uint8Array(this.size);
    this.frontier = new Uint8Array(this.size);
    this.region = new Uint16Array(this.size); // 0 = outer wall, n = nth capture
    this.regionCount = 0;
    this.trail = []; // ordered [{x, y}]
    this.trailStart = null; // SOLID cell the trail left from
    this.version = 0; // bumps whenever SOLID cells change
    this.interiorTotal = (cols - 2) * (rows - 2);
    this.capturedCount = 0;
    this._labels = new Int32Array(this.size);
    this._dist = new Int32Array(this.size);
    this._queue = new Int32Array(this.size);
    this._rail = null;
    this._railVersion = -1;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) this.cells[y * cols + x] = SOLID;
      }
    }
    this.recomputeFrontier();
  }

  /** Captured share of the interior, 0..1. */
  get fraction() {
    return this.interiorTotal > 0 ? this.capturedCount / this.interiorTotal : 1;
  }

  idx(x, y) {
    return y * this.cols + x;
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  /** Out of bounds reads as SOLID. */
  get(x, y) {
    return this.inBounds(x, y) ? this.cells[y * this.cols + x] : SOLID;
  }

  isEmpty(x, y) {
    return this.get(x, y) === EMPTY;
  }

  isSolid(x, y) {
    return this.get(x, y) === SOLID;
  }

  isTrail(x, y) {
    return this.get(x, y) === TRAIL;
  }

  isFrontier(x, y) {
    return this.inBounds(x, y) && this.frontier[y * this.cols + x] === 1;
  }

  recomputeFrontier() {
    const { cols, rows, cells, frontier } = this;
    frontier.fill(0);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (cells[i] !== SOLID) continue;
        let open = false;
        for (let dy = -1; dy <= 1 && !open; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            if (cells[ny * cols + nx] !== SOLID) {
              open = true;
              break;
            }
          }
        }
        if (open) frontier[i] = 1;
      }
    }
  }

  // ── Trail ────────────────────────────────────────────────────────────────

  beginTrail(x, y) {
    this.trailStart = { x, y };
    this.trail = [];
  }

  addTrail(x, y) {
    this.cells[y * this.cols + x] = TRAIL;
    this.trail.push({ x, y });
  }

  /** Drops the unfinished trail. Returns the cells that were cleared. */
  clearTrail() {
    const cleared = this.trail;
    for (const c of cleared) this.cells[c.y * this.cols + c.x] = EMPTY;
    this.trail = [];
    this.trailStart = null;
    return cleared;
  }

  // ── Capture ──────────────────────────────────────────────────────────────

  /**
   * Seals the current trail. The trail becomes SOLID, then every empty pocket
   * except the largest one is filled. Returns null when there is no trail.
   *
   * result.filled carries a wave distance `d` (4-way steps from the trail) so
   * the renderer can animate the fill rolling out from the line just drawn.
   */
  capture() {
    if (!this.trail.length) return null;
    const { cols, size, cells, region } = this;
    const fractionBefore = this.fraction;
    const trailCells = this.trail;
    const trailStart = this.trailStart;
    const regionId = ++this.regionCount;
    this.trail = [];
    this.trailStart = null;

    for (const c of trailCells) {
      const i = c.y * cols + c.x;
      cells[i] = SOLID;
      region[i] = regionId;
    }
    this.capturedCount += trailCells.length;

    // Label the 4-connected empty pockets.
    const labels = this._labels.fill(0);
    const queue = this._queue;
    const counts = [0];
    for (let s = 0; s < size; s++) {
      if (cells[s] !== EMPTY || labels[s]) continue;
      const id = counts.length;
      let head = 0;
      let tail = 0;
      queue[tail++] = s;
      labels[s] = id;
      while (head < tail) {
        const i = queue[head++];
        const x = i % cols;
        const y = (i - x) / cols;
        for (let k = 0; k < 4; k++) {
          const nx = x + NX[k];
          const ny = y + NY[k];
          if (!this.inBounds(nx, ny)) continue;
          const n = ny * cols + nx;
          if (cells[n] === EMPTY && !labels[n]) {
            labels[n] = id;
            queue[tail++] = n;
          }
        }
      }
      counts.push(tail);
    }

    let keep = 0;
    for (let id = 1; id < counts.length; id++) if (!keep || counts[id] > counts[keep]) keep = id;

    // Wave distances: multi-source BFS from the trail into the doomed pockets.
    const filled = [];
    let maxDist = 0;
    if (counts.length > 2) {
      const dist = this._dist.fill(-1);
      let head = 0;
      let tail = 0;
      for (const c of trailCells) {
        const i = c.y * cols + c.x;
        dist[i] = 0;
        queue[tail++] = i;
      }
      while (head < tail) {
        const i = queue[head++];
        const x = i % cols;
        const y = (i - x) / cols;
        for (let k = 0; k < 4; k++) {
          const nx = x + NX[k];
          const ny = y + NY[k];
          if (!this.inBounds(nx, ny)) continue;
          const n = ny * cols + nx;
          if (dist[n] !== -1 || cells[n] !== EMPTY || labels[n] === keep) continue;
          dist[n] = dist[i] + 1;
          if (dist[n] > maxDist) maxDist = dist[n];
          queue[tail++] = n;
        }
      }
      for (let i = 0; i < size; i++) {
        if (cells[i] !== EMPTY || labels[i] === keep) continue;
        const x = i % cols;
        const d = dist[i] > 0 ? dist[i] : maxDist + 1;
        filled.push({ x, y: (i - x) / cols, d });
      }
      for (const f of filled) {
        const i = f.y * cols + f.x;
        cells[i] = SOLID;
        region[i] = regionId;
        if (f.d > maxDist) maxDist = f.d;
      }
      this.capturedCount += filled.length;
    }

    this.recomputeFrontier();
    this.version++;

    let sx = 0;
    let sy = 0;
    for (const c of trailCells) (sx += c.x), (sy += c.y);
    for (const c of filled) (sx += c.x), (sy += c.y);
    const gained = trailCells.length + filled.length;

    return {
      regionId,
      trailStart,
      trailCells,
      filled,
      maxDist,
      gained,
      pockets: Math.max(0, counts.length - 2),
      centroid: { x: sx / gained, y: sy / gained },
      fractionBefore,
      fractionAfter: this.fraction,
    };
  }

  /**
   * Hands every cell of captured region `id` back to the open field (a chipper shattered it).
   * Returns null when there is no such region (the outer wall, id 0, is never one).
   */
  revertRegion(id) {
    if (!(id > 0)) return null;
    const { cols, size, cells, region } = this;
    const fractionBefore = this.fraction;
    const reverted = [];
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < size; i++) {
      if (region[i] !== id) continue;
      const x = i % cols;
      const y = (i - x) / cols;
      cells[i] = EMPTY;
      region[i] = 0;
      reverted.push({ x, y });
      sx += x;
      sy += y;
    }
    if (!reverted.length) return null;
    this.capturedCount -= reverted.length;
    this.recomputeFrontier();
    this.version++;
    return {
      regionId: id,
      cells: reverted,
      centroid: { x: sx / reverted.length, y: sy / reverted.length },
      fractionBefore,
      fractionAfter: this.fraction,
    };
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /** Frontier cell nearest the top (or bottom) edge, then nearest the horizontal centre. */
  spawnCell(where = 'top') {
    const { cols, rows, frontier } = this;
    const cx = (cols - 1) / 2;
    let best = null;
    let bestScore = Infinity;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!frontier[y * cols + x]) continue;
        const score = (where === 'bottom' ? rows - 1 - y : y) * cols * 2 + Math.abs(x - cx);
        if (score < bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    return best || { x: Math.round(cx), y: where === 'bottom' ? rows - 1 : 0 };
  }

  /**
   * Shortest 4-way walk through SOLID cells from (x, y) to the frontier.
   * Returns the steps after the start ([] when already there or unreachable).
   */
  pathToFrontier(x, y) {
    if (!this.inBounds(x, y) || this.isFrontier(x, y)) return [];
    const { cols, cells, frontier } = this;
    const prev = this._dist.fill(-1);
    const queue = this._queue;
    const start = y * cols + x;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    prev[start] = start;
    while (head < tail) {
      const i = queue[head++];
      if (frontier[i]) {
        const path = [];
        for (let c = i; c !== start; c = prev[c]) path.push({ x: c % cols, y: Math.floor(c / cols) });
        return path.reverse();
      }
      const cx = i % cols;
      const cy = (i - cx) / cols;
      for (let k = 0; k < 4; k++) {
        const nx = cx + NX[k];
        const ny = cy + NY[k];
        if (!this.inBounds(nx, ny)) continue;
        const n = ny * cols + nx;
        if (prev[n] !== -1 || cells[n] !== SOLID) continue;
        prev[n] = i;
        queue[tail++] = n;
      }
    }
    return [];
  }

  /** Whether a 4-way walk from (x, y) through EMPTY cells reaches a SOLID cell (or starts on one). */
  reachesLand(x, y) {
    if (this.isSolid(x, y)) return true;
    const { cols } = this;
    const seen = this._dist.fill(-1);
    const queue = this._queue;
    let head = 0;
    let tail = 0;
    queue[tail++] = y * cols + x;
    seen[queue[0]] = 0;
    while (head < tail) {
      const i = queue[head++];
      const cx = i % cols;
      const cy = (i - cx) / cols;
      for (let k = 0; k < 4; k++) {
        const nx = cx + NX[k];
        const ny = cy + NY[k];
        const state = this.get(nx, ny);
        if (state === SOLID) return true;
        const n = ny * cols + nx;
        if (state !== EMPTY || seen[n] !== -1) continue;
        seen[n] = 0;
        queue[tail++] = n;
      }
    }
    return false;
  }

  /** Nearest EMPTY cell to (x, y) by 4-way BFS across anything, or null. */
  nearestEmpty(x, y) {
    const { cells } = this;
    return this._nearest(x, y, (i) => cells[i] === EMPTY);
  }

  /** Nearest rail cell to (x, y) by 4-way BFS across anything, or null. */
  nearestFrontier(x, y) {
    const { frontier } = this;
    return this._nearest(x, y, (i) => frontier[i] === 1);
  }

  /** First cell index passing `test`, by 4-way BFS from (x, y) (rounded and clamped onto the board) across anything. */
  _nearest(x, y, test) {
    const { cols } = this;
    x = Math.min(cols - 1, Math.max(0, Math.round(x)));
    y = Math.min(this.rows - 1, Math.max(0, Math.round(y)));
    const seen = this._dist.fill(-1);
    const queue = this._queue;
    let head = 0;
    let tail = 0;
    queue[tail++] = y * cols + x;
    seen[queue[0]] = 0;
    while (head < tail) {
      const i = queue[head++];
      const cx = i % cols;
      const cy = (i - cx) / cols;
      if (test(i)) return { x: cx, y: cy };
      for (let k = 0; k < 4; k++) {
        const nx = cx + NX[k];
        const ny = cy + NY[k];
        if (!this.inBounds(nx, ny)) continue;
        const n = ny * cols + nx;
        if (seen[n] !== -1) continue;
        seen[n] = 0;
        queue[tail++] = n;
      }
    }
    return null;
  }

  /**
   * Rail line segments [x1, y1, x2, y2, ...] between neighbouring frontier
   * cells, skipping links buried inside thick walls. Cached per version.
   */
  railSegments() {
    if (this._rail && this._railVersion === this.version) return this._rail;
    const { cols, rows, frontier } = this;
    const open = (x, y) => this.get(x, y) !== SOLID;
    const out = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!frontier[y * cols + x]) continue;
        if (x + 1 < cols && frontier[y * cols + x + 1]) {
          if (open(x, y - 1) || open(x + 1, y - 1) || open(x, y + 1) || open(x + 1, y + 1)) out.push(x, y, x + 1, y);
        }
        if (y + 1 < rows && frontier[(y + 1) * cols + x]) {
          if (open(x - 1, y) || open(x - 1, y + 1) || open(x + 1, y) || open(x + 1, y + 1)) out.push(x, y, x, y + 1);
        }
      }
    }
    this._rail = out;
    this._railVersion = this.version;
    return out;
  }
}
