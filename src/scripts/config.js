// Shared constants for Nix. No imports, no side effects.

export const FIREBASE_URL = 'https://astro-nix-default-rtdb.europe-west1.firebasedatabase.app';

export const LEVEL_COUNT = 30;
export const WIN_FRACTION = 0.75;
export const START_LIVES = 3;
export const MAX_LIVES = 5; // extra-life pick-ups never push the count past this

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
  respawnInvuln: 2.0, // seconds, counted from the first move after the respawn
  deathPause: 1.6, // seconds between death and respawn
  playerBoost: 1.5, // speed multiplier while the speed power runs

  // Enemies
  sparxHitDist: 0.75, // cells, centre to centre
  qixHitSlack: 0.45, // qix kills the player when dist < qix.radius + qixHitSlack
  qixSpeed: 18, // cells / s: a touch faster than the player
  qixRadius: 0.5, // cells; the drawn body is the hitbox
  chipperSpeed: 15,
  chipperRadius: 0.88,
  chipperHits: 6, // impacts on one captured region before it shatters back to open field
  chipperHitCooldown: 0.25, // s: one bounce is one impact even if it grazes several sub-steps
  seekerCruise: 3, // cells / s while the player is safe on the rail
  seekerMax: 13, // cells / s at full chase: below the player's 16 so a quick cut can escape it
  seekerAccel: 9, // cells / s²
  seekerDecel: 6,
  seekerTurn: 2.4, // rad / s steering while locked on
  seekerRadius: 0.54,
  seekerHitSlack: 0.35,
  spawnerSpeed: 6,
  spawnerRadius: 1.7,
  spawnerPorts: 5,
  spawnerFirst: 5, // s before the first launch
  spawnerInterval: 10, // s between launches
  spawnerMaxQix: 3, // live qix (any origin) above which a spawner holds its fire

  // Pick-ups
  pickupFirst: 6, // s into the level before the first pick-up appears
  pickupGapMin: 8,
  pickupGapMax: 14,
  pickupLife: 36, // s a pick-up waits in the field (it blinks for the last 3)
  pickupReach: 0.95, // cells, arrowhead centre to pick-up centre
  pickupRadius: 0.8, // drawn radius, cells
  shieldGrace: 1.2, // s of total immunity (ship and line) after the shield absorbs a hit
};

export const POWER_TYPES = ['speed', 'freeze', 'slow', 'shield', 'cut', 'life'];
// Seconds each power runs; 0 means it is instant (life), armed until it fires (cut) or up until it takes a hit (shield).
export const POWERS = {
  speed: { duration: 6 },
  freeze: { duration: 4 },
  slow: { duration: 7, factor: 0.45 },
  shield: { duration: 0 }, // up until it absorbs a hit
  cut: { duration: 0 }, // armed until it fires
  life: { duration: 0 }, // instant
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
  chipper: '#ff5a3c',
  chipperBurst: ['#ffffff', '#ffd2bf', '#ff6a3d', '#d81b3c'],
  seeker: '#5dff95',
  seekerBurst: ['#ffffff', '#c8ffd9', '#5dff95', '#11a356'],
  spawner: '#9b5cff',
  spawnerBurst: ['#ffffff', '#dcc4ff', '#9b5cff', '#5b21b6'],
  powers: { speed: '#ffe45c', freeze: '#c8f6ff', slow: '#ffc46b', shield: '#59f0ff', cut: '#d6ff6b', life: '#bdf3ff' },
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
