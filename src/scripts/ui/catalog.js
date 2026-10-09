// What each enemy and power-up is called, what it does in one line, its icon (a Defs.astro symbol) and the colour
// it wears on the board. The level intro, the HUD, the chapter tiles and the field guide all read it from here.
// Pure data: HowtoScreen.astro also imports it at build time.

import { COLORS } from '../config.js';

const entry = (name, hint, icon, color) => Object.freeze({ name, hint, icon, color });

export const CATALOG = Object.freeze({
  sparx: entry('Sparx', 'Patrols the rail. Keep clear of it.', 'i-sparx', COLORS.sparx),
  qix: entry('Qix', 'Bounces through the field. Keep it off your line.', 'i-qix', COLORS.qix),
  chipper: entry('Chipper', "Cracks captured land. Six hits and it's lost.", 'i-chipper', COLORS.chipper),
  seeker: entry('Seeker', 'Dozes until you leave the rail, then hunts you.', 'i-seeker', COLORS.seeker),
  spawner: entry('Spawner', 'Launches new qix from its ports.', 'i-spawner', COLORS.spawner),
  speed: entry('Boost', 'Move faster for a few seconds.', 'i-pw-speed', COLORS.powers.speed),
  freeze: entry('Time stop', 'Freezes every enemy.', 'i-pw-freeze', COLORS.powers.freeze),
  slow: entry('Slow-mo', 'Slows every enemy down.', 'i-pw-slow', COLORS.powers.slow),
  shield: entry('Shield', 'Absorbs one hit to you or your line.', 'i-pw-shield', COLORS.powers.shield),
  cut: entry('Instant cut', 'Finishes your line straight ahead.', 'i-pw-cut', COLORS.powers.cut),
  life: entry('Extra life', 'One more try.', 'i-pw-life', COLORS.powers.life),
});

/** The entry for `key` (an enemy kind or a power type), or null for anything else: a level's `intro` may be null. */
export function entryFor(key) {
  return typeof key === 'string' && Object.hasOwn(CATALOG, key) ? CATALOG[key] : null;
}

/** Enemy kinds in the order the UI lists them: the rail first, then the field, roughly by when they arrive. */
export const FOE_KINDS = Object.freeze(['sparx', 'qix', 'chipper', 'seeker', 'spawner']);

/**
 * A level's line-up as `[{ kind, count }]` in FOE_KINDS order: the sparx from `def.sparx`, every other kind from
 * `def.foes`. Kinds the catalog does not know are left out, so a newer level table cannot break the menus.
 */
export function lineup(def) {
  const counts = new Map(FOE_KINDS.map((kind) => [kind, 0]));
  counts.set('sparx', def?.sparx?.length ?? 0);
  for (const foe of def?.foes ?? []) {
    if (foe.kind !== 'sparx' && counts.has(foe.kind)) counts.set(foe.kind, counts.get(foe.kind) + 1);
  }
  return FOE_KINDS.filter((kind) => counts.get(kind) > 0).map((kind) => ({ kind, count: counts.get(kind) }));
}
