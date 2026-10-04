// Game-pad style focus movement: arrow keys / WASD walk through the buttons of the current screen or overlay.

const NEXT = new Set(['ArrowDown', 'ArrowRight', 'KeyS', 'KeyD']);
const PREVIOUS = new Set(['ArrowUp', 'ArrowLeft', 'KeyW', 'KeyA']);

/** Moves focus within `scope` (DOM order, wrapping) when `event` is a navigation key. Text fields keep their keys. */
export function moveFocus(scope, event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const step = NEXT.has(event.code) ? 1 : PREVIOUS.has(event.code) ? -1 : 0;
  if (step === 0 || event.target.matches?.('input, textarea, select')) return;
  const buttons = [...scope.querySelectorAll('button:not([hidden]):not(:disabled)')];
  if (buttons.length === 0) return;
  event.preventDefault();
  const index = buttons.indexOf(document.activeElement);
  const next = index === -1 ? (step === 1 ? 0 : buttons.length - 1) : (index + step + buttons.length) % buttons.length;
  buttons[next].focus({ preventScroll: true });
}
