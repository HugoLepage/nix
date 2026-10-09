import { COLORS, SOLID, TUNING } from '../config.js';
import { TAU, clamp01 } from './fx-util.js';

const CRACK_STEP = 0.42; // cells per crack segment, on average
const CRACK_WANDER = 0.9; // rad of zig-zag per segment, either way
const BRANCH_CHANCE = 0.22; // per segment of a main crack
const ANCHOR_REACH = 2; // cells searched round a contact point for the struck region
const FRESH_LIFE = 0.4; // seconds a new crack burns white
const HOT_FROM = 0.5; // share of chipperHits from which the cracks smoulder: the region is about to go
const CRACK_SHADOW = 'rgba(2, 14, 52, 1)';
const CRACK_LIGHT = '#f4fdff';
const SHARD_LIFE = 1.15;
const SHARD_GRAVITY = 18; // cells / s²: the ice "falls" down the screen
const SHARD_STRIDE = 13; // x, y, vx, vy, angle, spin, colour, then three corners (x, y) around the centre
const MAX_SHARDS = 150;
const SHARD_COLORS = ['#e9fbff', COLORS.ice[0], COLORS.ice[1], COLORS.ice[2], '#aeeeff'];

/**
 * Chipper damage. Each impact on a captured region adds cracks that radiate from the impact point and stay
 * inside that region, denser and longer with every hit; once the region shatters its cracks go and its ice
 * bursts into falling glass shards. Everything is kept in cells and drawn per frame, so a resize or re-bake
 * never needs to know about it.
 */
export class Damage {
  constructor({ lowPower = false } = {}) {
    this.lowPower = lowPower;
    this.reset();
  }

  /** New level. */
  reset() {
    this._regions = new Map(); // regionId → { lines: Float32Array[], hits, fresh, freshT }
    this._bursts = [];
  }

  // ── Moments ──────────────────────────────────────────────────────────────

  /** A chipper hit captured region `regionId` at (x, y) for the `hits`-th time. */
  impact(grid, x, y, regionId, hits) {
    if (!grid || !(regionId > 0)) return;
    const anchor = findAnchor(grid, x, y, regionId);
    if (!anchor) return;
    let region = this._regions.get(regionId);
    if (!region) this._regions.set(regionId, (region = { lines: [], hits: 0, fresh: 0, freshT: FRESH_LIFE }));
    region.hits = Math.max(region.hits, hits);
    region.fresh = region.lines.length;
    region.freshT = 0;
    const severity = clamp01(hits / TUNING.chipperHits);
    const count = 2 + Math.round(severity * 5);
    // Fanned round the line from the contact point into the struck cell: the cracks run into the ice.
    const inward = Math.atan2(anchor.cy - y, anchor.cx - x);
    for (let k = 0; k < count; k++) {
      const a = inward + ((k + 0.5) / count - 0.5) * 2.6 + (Math.random() - 0.5) * 0.4;
      const length = (1 + 3.2 * severity) * (0.7 + Math.random() * 0.6);
      crack(grid, regionId, anchor.x, anchor.y, a, length, region.lines, true);
    }
  }

  /** The region went back to open field (grid.revertRegion result): its cracks go, its ice bursts. */
  shatter(result) {
    this._regions.delete(result.regionId);
    const { cells, centroid } = result;
    if (!cells || !cells.length) return;
    const n = Math.round(Math.min(MAX_SHARDS, Math.max(12, cells.length * 0.35)) * (this.lowPower ? 0.5 : 1));
    const data = new Float32Array(n * SHARD_STRIDE);
    for (let i = 0; i < n; i++) {
      const cell = cells[(Math.random() * cells.length) | 0];
      const o = i * SHARD_STRIDE;
      const x = cell.x + Math.random() - 0.5;
      const y = cell.y + Math.random() - 0.5;
      const dx = x - centroid.x;
      const dy = y - centroid.y;
      const d = Math.hypot(dx, dy) || 1;
      const out = 0.5 + Math.random() * 3;
      const size = 0.3 + Math.random() * 0.55;
      data[o] = x;
      data[o + 1] = y;
      data[o + 2] = (dx / d) * out + (Math.random() - 0.5) * 2;
      data[o + 3] = (dy / d) * out - (2 + Math.random() * 5); // a hop up before the fall
      data[o + 4] = Math.random() * TAU;
      data[o + 5] = (Math.random() - 0.5) * 10;
      data[o + 6] = (Math.random() * SHARD_COLORS.length) | 0;
      for (let v = 0; v < 3; v++) {
        const a = (v * TAU) / 3 + (Math.random() - 0.5) * 1.1;
        const r = size * (0.55 + Math.random() * 0.45);
        data[o + 7 + v * 2] = Math.cos(a) * r;
        data[o + 8 + v * 2] = Math.sin(a) * r;
      }
    }
    this._bursts.push({ data, n, t: 0 });
  }

  // ── Per-frame ────────────────────────────────────────────────────────────

  update(dt) {
    for (const region of this._regions.values()) region.freshT += dt;
    const bursts = this._bursts;
    for (let b = bursts.length - 1; b >= 0; b--) {
      const burst = bursts[b];
      burst.t += dt;
      if (burst.t >= SHARD_LIFE) {
        bursts.splice(b, 1);
        continue;
      }
      const { data, n } = burst;
      for (let i = 0; i < n; i++) {
        const o = i * SHARD_STRIDE;
        data[o + 3] += SHARD_GRAVITY * dt;
        data[o] += data[o + 2] * dt;
        data[o + 1] += data[o + 3] * dt;
        data[o + 4] += data[o + 5] * dt;
      }
    }
  }

  /** On the ice, under the rail. view = the Renderer; `time` drives the smoulder. */
  drawCracks(ctx, view, time) {
    if (!this._regions.size) return;
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    const drop = Math.max(0.75, cs * 0.06); // px the shadow sits down-right of the bright fracture
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const region of this._regions.values()) {
      const { lines } = region;
      if (!lines.length) continue;
      const severity = clamp01(region.hits / TUNING.chipperHits);
      ctx.globalCompositeOperation = 'source-over';
      tracePath(ctx, lines, 0, ox + drop, oy + drop, cs);
      ctx.strokeStyle = CRACK_SHADOW;
      ctx.globalAlpha = 0.5 + 0.3 * severity;
      ctx.lineWidth = Math.max(1, cs * (0.1 + 0.06 * severity));
      ctx.stroke();
      tracePath(ctx, lines, 0, ox, oy, cs);
      ctx.strokeStyle = CRACK_LIGHT;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(1, cs * 0.05);
      ctx.stroke();
      if (severity >= HOT_FROM && !this.lowPower) {
        // About to go: the cracks smoulder in the chipper's colour, faster as the hits add up.
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = COLORS.chipper;
        ctx.globalAlpha = (0.1 + 0.22 * severity) * (0.6 + 0.4 * Math.sin(time * (4 + 6 * severity)));
        ctx.lineWidth = cs * 0.34;
        ctx.stroke();
      }
      if (region.freshT < FRESH_LIFE && region.fresh < lines.length) {
        tracePath(ctx, lines, region.fresh, ox, oy, cs);
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = (1 - region.freshT / FRESH_LIFE) ** 1.5;
        ctx.lineWidth = Math.max(1.5, cs * 0.22);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Falling glass, batched by colour: one fill per colour, one stroke for every edge. */
  drawShards(ctx, view) {
    if (!this._bursts.length) return;
    const cs = view.cellSize;
    const ox = view.offsetX + cs * 0.5;
    const oy = view.offsetY + cs * 0.5;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineJoin = 'round';
    for (const burst of this._bursts) {
      const fade = (1 - burst.t / SHARD_LIFE) ** 1.3;
      for (let c = 0; c <= SHARD_COLORS.length; c++) {
        const edges = c === SHARD_COLORS.length;
        ctx.beginPath();
        for (let i = 0; i < burst.n; i++) {
          const o = i * SHARD_STRIDE;
          if (!edges && burst.data[o + 6] !== c) continue;
          traceShard(ctx, burst.data, o, ox, oy, cs);
        }
        if (edges) {
          ctx.strokeStyle = '#ffffff';
          ctx.globalAlpha = 0.7 * fade;
          ctx.lineWidth = Math.max(1, cs * 0.04);
          ctx.stroke();
        } else {
          ctx.fillStyle = SHARD_COLORS[c];
          ctx.globalAlpha = 0.85 * fade;
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }
}

/**
 * The cell of `regionId` nearest the contact point, and the point on that cell's square nearest the contact:
 * the crack starts on the face of the wall that was struck. Null when no cell of the region is in reach.
 */
function findAnchor(grid, x, y, regionId) {
  const { cols, cells, region } = grid;
  const rx = Math.round(x);
  const ry = Math.round(y);
  let best = null;
  let bestD = Infinity;
  for (let cy = ry - ANCHOR_REACH; cy <= ry + ANCHOR_REACH; cy++) {
    for (let cx = rx - ANCHOR_REACH; cx <= rx + ANCHOR_REACH; cx++) {
      if (!grid.inBounds(cx, cy)) continue;
      const i = cy * cols + cx;
      if (cells[i] !== SOLID || region[i] !== regionId) continue;
      const px = Math.max(cx - 0.45, Math.min(cx + 0.45, x));
      const py = Math.max(cy - 0.45, Math.min(cy + 0.45, y));
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x: px, y: py, cx, cy };
      }
    }
  }
  return best;
}

function inRegion(grid, x, y, regionId) {
  const cx = Math.round(x);
  const cy = Math.round(y);
  if (!grid.inBounds(cx, cy)) return false;
  const i = cy * grid.cols + cx;
  return grid.cells[i] === SOLID && grid.region[i] === regionId;
}

/** A zig-zag walk from (x, y) that stops where the region ends; main cracks fork now and then. */
function crack(grid, regionId, x, y, angle, length, out, main) {
  const points = [x, y];
  let a = angle;
  let travelled = 0;
  while (travelled < length) {
    a += (Math.random() - 0.5) * CRACK_WANDER;
    const step = CRACK_STEP * (0.7 + Math.random() * 0.6);
    const nx = x + Math.cos(a) * step;
    const ny = y + Math.sin(a) * step;
    if (!inRegion(grid, nx, ny, regionId)) break;
    points.push(nx, ny);
    x = nx;
    y = ny;
    travelled += step;
    if (main && Math.random() < BRANCH_CHANCE && travelled < length * 0.8) {
      const fork = a + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.6);
      crack(grid, regionId, x, y, fork, (length - travelled) * 0.55, out, false);
    }
  }
  if (points.length >= 4) out.push(Float32Array.from(points));
}

function tracePath(ctx, lines, from, ox, oy, cs) {
  ctx.beginPath();
  for (let l = from; l < lines.length; l++) {
    const pts = lines[l];
    ctx.moveTo(ox + pts[0] * cs, oy + pts[1] * cs);
    for (let k = 2; k < pts.length; k += 2) ctx.lineTo(ox + pts[k] * cs, oy + pts[k + 1] * cs);
  }
}

function traceShard(ctx, data, o, ox, oy, cs) {
  const c = Math.cos(data[o + 4]);
  const s = Math.sin(data[o + 4]);
  const x = ox + data[o] * cs;
  const y = oy + data[o + 1] * cs;
  for (let v = 0; v < 3; v++) {
    const vx = data[o + 7 + v * 2];
    const vy = data[o + 8 + v * 2];
    const px = x + (vx * c - vy * s) * cs;
    const py = y + (vx * s + vy * c) * cs;
    if (v) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.closePath();
}
