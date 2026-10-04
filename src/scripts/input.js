// Player input: arrow keys / WASD, swipes (touch, pen or mouse drag), and the pause keys.

const KEY_DIRECTIONS = {
  ArrowUp: 'up',
  ArrowRight: 'right',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  KeyW: 'up',
  KeyD: 'right',
  KeyS: 'down',
  KeyA: 'left',
};
// By printed letter as well: on AZERTY the keys labelled W and A sit where QWERTY has Z and Q. The code map wins,
// so physical positions keep working (ZQSD on AZERTY) and no layout maps one key to two directions.
const LETTER_DIRECTIONS = { w: 'up', a: 'left', s: 'down', d: 'right' };
const PAUSE_KEYS = new Set(['Escape', 'KeyP']);
// Keys that belong to the browser or to keyboard navigation and must never count as "press any key".
const PASSIVE_KEYS = /^(Tab|Shift|Control|Alt|Meta|OS|CapsLock|NumLock|ScrollLock|ContextMenu|F\d+)/;
const ACTIVATION_KEYS = new Set(['Enter', 'NumpadEnter', 'Space']);
const SWIPE_DISTANCE = 22; // CSS px along the dominant axis

const isTextField = (node) => node instanceof HTMLElement && node.matches('input, textarea, select, [contenteditable]');
const isControl = (node) => node instanceof Element && node.closest('button, a[href]') !== null;

/**
 * Wires keyboard and pointer input.
 *   onDirection('up' | 'right' | 'down' | 'left')
 *   onPause(code)   Escape or P (the KeyboardEvent code)
 *   onAny()     any other key press, or the end of any touch / click on `target` (a tap or a finished swipe).
 *               Pointer input reports on release because only then does the browser grant the user activation
 *               that fullscreen needs. For a key that is also a direction, onAny fires first.
 * `target` must have `touch-action: none` (game.css), otherwise the browser claims the gesture for scrolling.
 * Keys typed into form fields and presses on buttons are left alone. Returns `{ destroy() }`.
 */
export function createInput({ target, onDirection, onPause, onAny }) {
  const listeners = new AbortController();
  const { signal } = listeners;
  let pointerId = null;
  let originX = 0;
  let originY = 0;

  function onKeyDown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || isTextField(event.target)) return;
    const direction = KEY_DIRECTIONS[event.code] ?? LETTER_DIRECTIONS[event.key?.toLowerCase()];
    if (direction) {
      event.preventDefault();
      if (event.repeat) return;
      onAny?.();
      onDirection?.(direction);
    } else if (PAUSE_KEYS.has(event.code)) {
      event.preventDefault();
      if (!event.repeat) onPause?.(event.code);
    } else if (!event.repeat && !PASSIVE_KEYS.test(event.code)) {
      // Enter / Space on a focused button is that button's click, not a wake-up call.
      if (ACTIVATION_KEYS.has(event.code) && isControl(event.target)) return;
      onAny?.();
    }
  }

  function onPointerDown(event) {
    // A new primary pointer always starts a new gesture, even if the last one's release never arrived
    // (it can be lost to an app switch): waiting for it would ignore every swipe from then on.
    if (!event.isPrimary || event.button !== 0 || isControl(event.target)) return;
    pointerId = event.pointerId;
    originX = event.clientX;
    originY = event.clientY;
  }

  function onPointerMove(event) {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - originX;
    const dy = event.clientY - originY;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_DISTANCE) return;
    // Re-anchor so one continuous drag can chain turns.
    originX = event.clientX;
    originY = event.clientY;
    if (horizontal) onDirection?.(dx > 0 ? 'right' : 'left');
    else onDirection?.(dy > 0 ? 'down' : 'up');
  }

  function onPointerEnd(event) {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    if (event.type === 'pointerup') onAny?.();
  }

  const prevent = (event) => event.preventDefault();

  window.addEventListener('keydown', onKeyDown, { signal });
  target.addEventListener('pointerdown', onPointerDown, { signal });
  // On window: a drag that leaves the target (or the viewport) must still steer and still end.
  window.addEventListener('pointermove', onPointerMove, { signal });
  window.addEventListener('pointerup', onPointerEnd, { signal });
  window.addEventListener('pointercancel', onPointerEnd, { signal });
  // Belt and braces for browsers that scroll, zoom or open menus despite `touch-action: none`.
  target.addEventListener('touchmove', prevent, { signal, passive: false });
  target.addEventListener('gesturestart', prevent, { signal });
  target.addEventListener('contextmenu', prevent, { signal });

  return { destroy: () => listeners.abort() };
}
