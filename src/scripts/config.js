// Shared constants for Nix. No imports, no side effects.

export const FIREBASE_URL = 'https://astro-nix-default-rtdb.europe-west1.firebasedatabase.app';

export const LEVEL_COUNT = 3;
export const WIN_FRACTION = 0.75;
export const START_LIVES = 3;

// Cell states
export const EMPTY = 0;
export const SOLID = 1;
export const TRAIL = 2;

// Directions. DIR_NAMES is in clockwise order: index + 1 turns right, index - 1 turns left.
export const DIR_NAMES = ['up', 'right', 'down', 'left'];
export const DIRS = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

export const TUNING = {
  // Board sizing: the grid is shaped to the viewport at level start.
  targetCells: 3000,
  // Wide enough for a landscape phone's play strip (~2.9 : 1) without letterboxing it to two thirds.
  minAspect: 1 / 3,
  maxAspect: 3,
  minSide: 24,

  // Player
  playerSpeed: 16, // cells / second
  playerRadius: 0.45, // cells
  respawnInvuln: 2.0, // seconds
  deathPause: 1.6, // seconds between death and respawn

  // Enemies
  sparxHitDist: 0.75, // cells, centre to centre
  qixHitSlack: 0.45, // qix kills the player when dist < qix.radius + qixHitSlack
};

export const COLORS = {
  bg: '#04060c',
  bgGlow: '#0b1428',
  gridDot: 'rgba(140, 200, 255, 0.10)',
  ice: ['#bdf3ff', '#7fdcff', '#4db8ff', '#3b82f6'], // light → deep, the menu / fill gradient
  rail: '#e6fbff',
  trail: '#9ff0ff',
  player: '#ffffff',
  playerBurst: ['#ffffff', '#bdf3ff', '#5cd0ff', '#3b82f6'],
  sparx: '#ffb347',
  sparxBurst: ['#fff3c4', '#ffd166', '#ff9f1c', '#ff5d3b'],
  qix: '#ff4fd8',
  qixBurst: ['#ffffff', '#ffb3f1', '#ff4fd8', '#a855f7'],
};

/** Grid dimensions (including the 1-cell outer wall) for a given pixel box. */
export function computeGridSize(widthPx, heightPx) {
  const { targetCells, minAspect, maxAspect, minSide } = TUNING;
  const raw = widthPx > 0 && heightPx > 0 ? widthPx / heightPx : 1.6;
  const aspect = Math.min(maxAspect, Math.max(minAspect, raw));
  const rows = Math.max(minSide, Math.round(Math.sqrt(targetCells / aspect)));
  const cols = Math.max(minSide, Math.round(rows * aspect));
  return { cols, rows };
}
