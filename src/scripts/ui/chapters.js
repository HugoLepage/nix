// Chapter select: one tile per level — locked, open (next to beat) or cleared with its best time.

import { LEVEL_COUNT } from '../config.js';
import { getLevel } from '../game/levels.js';
import { store } from '../store.js';
import { $, el, formatTime, icon, pad2, shake, vibrate } from './dom.js';

const STATUS_ICONS = { locked: 'i-lock', open: 'i-play', cleared: 'i-check' };
const STATE_LABELS = { locked: 'locked', open: 'not cleared yet', cleared: 'cleared' };
const ENTRANCE_MS = 600;

export function createChapters(root, { onSelect }) {
  const grid = $('#chapter-grid', root);
  const tiles = new Map();

  for (let level = 1; level <= LEVEL_COUNT; level++) {
    const tile = el('button', 'tile');
    tile.type = 'button';
    // What waits inside: one glyph per enemy, in the colours they wear on the board.
    const { sparx, qix } = getLevel(level);
    const foes = el('span', 'tile-foes');
    foes.append(...sparx.map(() => icon('i-sparx', 'foe')), ...qix.map(() => icon('i-qix', 'foe')));
    const head = el('span', 'tile-head');
    head.append(el('span', 'tile-number', pad2(level)), foes);
    const foot = el('span', 'tile-foot');
    foot.append(el('span', 'tile-status'), el('span', 'tile-best'));
    tile.append(head, foot);
    tile.addEventListener('click', () => {
      if (store.isUnlocked(level)) onSelect(level);
      else reject(level);
    });
    tiles.set(level, tile);
    grid.append(tile);
  }

  function update() {
    const { unlocked, best } = store.progress;
    for (const [level, tile] of tiles) {
      const state = level > unlocked ? 'locked' : level === unlocked ? 'open' : 'cleared';
      const time = best[`l${level}`];
      const bestText = time === undefined ? '' : formatTime(time);
      tile.querySelector('.tile-best').textContent = bestText;
      tile.setAttribute('aria-label', `Level ${level}, ${STATE_LABELS[state]}${bestText && `, best ${bestText}`}`);
      // A locked tile stays focusable and clickable so it can answer with a shake; it is only announced as disabled.
      tile.setAttribute('aria-disabled', String(state === 'locked'));
      tile.toggleAttribute('data-autofocus', level === store.continueLevel());
      if (tile.dataset.state === state) continue;
      tile.dataset.state = state;
      tile.querySelector('.tile-status').replaceChildren(
        icon(STATUS_ICONS[state], state === 'open' ? 'icon icon-solid' : 'icon'),
      );
    }
  }

  /**
   * The "not yet" answer for a locked level. Unknown levels are ignored.
   * `afterEntrance` holds the shake until the screen's entrance animation has brought the tile in.
   */
  function reject(level, { afterEntrance = false } = {}) {
    const tile = tiles.get(level);
    if (!tile) return;
    shake(tile, afterEntrance ? ENTRANCE_MS : 0);
    vibrate(20);
  }

  return { update, reject };
}
