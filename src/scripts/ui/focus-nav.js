// Game-pad style focus movement: arrow keys / WASD walk through the buttons of the current screen or overlay.
// Up / Down move to the nearest button above or below, so a grid of tiles is walked by columns; Left / Right to the
// nearest one in the same row. With nothing that way, Up / Down wrap round to the far end of the same column and
// Left / Right step on in DOM order (wrapping), which carries a row's end over to the next row and keeps a single
// row or column fully reachable.

import { reveal } from './dom.js';

const DIRECTIONS = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowRight: 'right',
  KeyD: 'right',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
};
const CROSS_WEIGHT = 2; // px of travel that one px of sideways drift costs: a move keeps to its row or column

/** Moves focus within `scope` when `event` is a navigation key, scrolling it into view. Text fields keep their keys. */
export function moveFocus(scope, event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const direction = DIRECTIONS[event.code];
  if (!direction || event.target.matches?.('input, textarea, select')) return;
  // Laid-out buttons only: one inside a `display: none` part cannot take focus.
  const buttons = [...scope.querySelectorAll('button:not([hidden]):not(:disabled)')].filter(
    (button) => button.getClientRects().length > 0,
  );
  if (buttons.length === 0) return;
  // A lone button (How to play's Back) has nowhere to walk to: focus settles on it without moving the view, and the
  // key keeps its default, so the arrows scroll the screen.
  if (buttons.length === 1) {
    buttons[0].focus({ preventScroll: true });
    return;
  }
  event.preventDefault();
  const forward = direction === 'down' || direction === 'right';
  const count = buttons.length;
  const index = buttons.indexOf(document.activeElement);
  let next = buttons[forward ? 0 : count - 1];
  if (index !== -1) {
    const vertical = direction === 'up' || direction === 'down';
    next =
      nearest(buttons, index, direction) ??
      (vertical ? wrapColumn(buttons, index, forward) : null) ??
      buttons[(index + (forward ? 1 : -1) + count) % count];
  }
  next.focus({ preventScroll: true });
  reveal(next, { smooth: true });
}

/** Centre and box of an element, in viewport pixels. */
function measure(element) {
  const box = element.getBoundingClientRect();
  return { box, x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/**
 * The closest button whose centre lies beyond `buttons[index]`'s edge in `direction`, scored by the gap to cross
 * plus weighted sideways drift. Left / Right only look along the same row (a menu's Right still means "next", not
 * a jump to a corner button). Null when there is none.
 */
function nearest(buttons, index, direction) {
  const from = measure(buttons[index]);
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'down' || direction === 'right' ? 1 : -1;
  const reach = (vertical ? from.box.height : from.box.width) / 2;
  let best = null;
  let bestScore = Infinity;
  buttons.forEach((button, i) => {
    if (i === index) return;
    const to = measure(button);
    if (!vertical && (to.box.bottom <= from.box.top || to.box.top >= from.box.bottom)) return;
    const along = (vertical ? to.y - from.y : to.x - from.x) * sign;
    if (along <= reach) return;
    const half = (vertical ? to.box.height : to.box.width) / 2;
    const gap = Math.max(0, along - reach - half);
    const score = gap + CROSS_WEIGHT * Math.abs(vertical ? to.x - from.x : to.y - from.y);
    if (score < bestScore) {
      bestScore = score;
      best = button;
    }
  });
  return best;
}

/** Up past the top (or down past the bottom): the button at the other end of the same column, or null. */
function wrapColumn(buttons, index, forward) {
  const from = measure(buttons[index]);
  let best = null;
  let bestY = forward ? Infinity : -Infinity;
  buttons.forEach((button, i) => {
    if (i === index) return;
    const to = measure(button);
    if (from.x < to.box.left || from.x > to.box.right) return;
    if (forward ? to.y < bestY : to.y > bestY) {
      bestY = to.y;
      best = button;
    }
  });
  return best;
}
