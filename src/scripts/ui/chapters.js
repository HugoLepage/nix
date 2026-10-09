// Chapter select: one tile per level — locked, open (next to beat) or cleared with its best time — showing who waits
// inside, and what the level brings in when it introduces something new.

import { LEVEL_COUNT } from '../config.js';
import { getLevel } from '../game/levels.js';
import { store } from '../store.js';
import { CATALOG, entryFor, lineup } from './catalog.js';
import { $, el, formatTime, icon, pad2, reveal, shake, tint, vibrate } from './dom.js';

const STATUS_ICONS = { locked: 'i-lock', open: 'i-play', cleared: 'i-check' };
const STATE_LABELS = { locked: 'locked', open: 'not cleared yet', cleared: 'cleared' };
const ENTRANCE_MS = 600; // how long a tile takes to rise into place …
const STAGGER_MS = 16; // … starting this much after the tile before it (ui.css reads --n)

/** "Sparx", "2 Qix", "2 Seekers": the line-up as a screen reader says it. */
function describeLineup(groups) {
  return groups
    .map(({ kind, count }) => {
      const { name } = CATALOG[kind];
      if (count === 1) return name;
      return `${count} ${name.endsWith('x') ? name : `${name}s`}`;
    })
    .join(', ');
}

/** Enemy glyphs grouped by kind, with a ×N count where there are several. */
function lineupRow(groups) {
  const row = el('span', 'tile-foes');
  for (const { kind, count } of groups) {
    const group = el('span', 'foe-group');
    group.style.setProperty('--glow', tint(CATALOG[kind].color, 0.6));
    group.append(icon(CATALOG[kind].icon, 'foe'));
    if (count > 1) group.append(el('span', 'foe-count', `×${count}`));
    row.append(group);
  }
  return row;
}

/** The small badge on a level that introduces an enemy or a power-up. */
function newMarker(entry) {
  const marker = el('span', 'tile-new');
  marker.style.setProperty('--accent', entry.color);
  marker.style.setProperty('--accent-glow', tint(entry.color, 0.45));
  marker.append(icon(entry.icon, 'tile-new-icon'), el('span', 'tile-new-label', 'New'));
  return marker;
}

export function createChapters(root, { onSelect }) {
  const grid = $('#chapter-grid', root);
  const tiles = new Map();
  const summaries = new Map(); // level → the static tail of its tile's label

  for (let level = 1; level <= LEVEL_COUNT; level++) {
    const def = getLevel(level);
    const groups = lineup(def);
    const intro = entryFor(def?.intro);
    const tile = el('button', 'tile');
    tile.type = 'button';
    tile.style.setProperty('--n', String(level - 1));
    const head = el('span', 'tile-head');
    head.append(el('span', 'tile-number', pad2(level)));
    if (intro) head.append(newMarker(intro));
    const foot = el('span', 'tile-foot');
    foot.append(el('span', 'tile-status'), el('span', 'tile-best'));
    tile.append(head, lineupRow(groups), foot);
    tile.addEventListener('click', () => {
      if (store.isUnlocked(level)) onSelect(level);
      else reject(level);
    });
    const lineupText = groups.length ? `, ${describeLineup(groups)}` : '';
    summaries.set(level, `${lineupText}${intro ? `, new: ${intro.name}` : ''}`);
    tiles.set(level, tile);
    grid.append(tile);
  }

  function update() {
    const { unlocked, best } = store.progress;
    const continueLevel = store.continueLevel();
    for (const [level, tile] of tiles) {
      const state = level > unlocked ? 'locked' : level === unlocked ? 'open' : 'cleared';
      const time = best[`l${level}`];
      const bestText = time === undefined ? '' : formatTime(time);
      tile.querySelector('.tile-best').textContent = bestText;
      tile.setAttribute(
        'aria-label',
        `Level ${level}, ${STATE_LABELS[state]}${bestText && `, best ${bestText}`}${summaries.get(level)}`,
      );
      // A locked tile stays focusable and clickable so it can answer with a shake; it is only announced as disabled.
      tile.setAttribute('aria-disabled', String(state === 'locked'));
      tile.toggleAttribute('data-autofocus', level === continueLevel);
      if (tile.dataset.state === state) continue;
      tile.dataset.state = state;
      tile.querySelector('.tile-status').replaceChildren(
        icon(STATUS_ICONS[state], state === 'open' ? 'icon icon-solid' : 'icon'),
      );
    }
  }

  /**
   * The "not yet" answer for a locked level: its tile is scrolled to and shakes. Unknown levels are ignored.
   * `afterEntrance` holds the shake until the screen's entrance animation has brought the tile in.
   */
  function reject(level, { afterEntrance = false } = {}) {
    const tile = tiles.get(level);
    if (!tile) return;
    reveal(tile, { center: afterEntrance, smooth: !afterEntrance });
    shake(tile, afterEntrance ? ENTRANCE_MS + (level - 1) * STAGGER_MS : 0);
    vibrate(20);
  }

  return { update, reject };
}
