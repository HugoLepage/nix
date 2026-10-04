// Double-activation guard. Screens and overlays switch the moment a button is clicked, so the second half of a double
// click or double tap would land on whatever the first half brought up: a Start or Continue button, a chapter tile,
// the intro card. A press that begins shortly after a click that switched the view is that second half: it is dropped.

// Covers slow double clicks, and double taps (Android allows 300 ms between the taps, plus the tap itself).
const SETTLE_MS = 500;

let switches = 0;
let lastClick = { at: -Infinity, switches: 0 };

/** Screens and overlays call this whenever they bring a new view up. */
export function markSwitch() {
  switches++;
}

/**
 * Installs the guard on `root`, in the capture phase so it runs before every handler inside. Only pointer presses
 * are judged: keyboard activation and `element.click()` (click `detail` 0) always go through, and a switch that no
 * click caused (deep link, timer, key) holds nothing back. Times are the events' own input times, so a press that
 * waited behind a busy main thread (a level loading) is still recognised.
 */
export function guardDoubleActivation(root) {
  let dropping = false;

  root.addEventListener(
    'pointerdown',
    (event) => {
      // Decided once per press, so a slow release cannot let the click through after the window closes.
      dropping = switches !== lastClick.switches && event.timeStamp - lastClick.at < SETTLE_MS;
      if (dropping) event.stopPropagation();
    },
    { capture: true },
  );

  root.addEventListener(
    'click',
    (event) => {
      if (event.detail === 0) return;
      if (dropping) {
        event.stopPropagation();
        event.preventDefault();
      } else {
        lastClick = { at: event.timeStamp, switches };
      }
    },
    { capture: true },
  );
}
