// In-game overlays: intro, pause, win, lose. At most one is open; its buttons report `data-action` names.

import { $, formatTime, pad2 } from './dom.js';
import { markSwitch } from './settle.js';

/** `onAction(name)` receives the `data-action` of whichever overlay button was activated. */
export function createOverlays(root, { onAction }) {
  const overlays = new Map([...root.querySelectorAll('[data-overlay]')].map((node) => [node.dataset.overlay, node]));
  let current = null;

  const fillers = {
    intro({ level }) {
      $('#intro-level', root).textContent = pad2(level);
    },
    win({ time, best, fraction, last }) {
      $('#win-time', root).textContent = formatTime(time);
      $('#win-best', root).hidden = !best;
      $('#win-percent', root).textContent = String(Math.floor(fraction * 100 + 1e-9));
      // After the last level there is no "next": the primary action leads back to the chapters.
      $('[data-action="next"]', root).hidden = last;
      $('[data-action="chapters"]', root).hidden = !last;
    },
  };

  function show(name, data = {}) {
    fillers[name]?.(data);
    current = name;
    markSwitch();
    for (const [key, node] of overlays) {
      node.classList.toggle('is-open', key === name);
      node.inert = key !== name;
    }
    overlays.get(name).querySelector('[data-autofocus]:not([hidden])')?.focus({ preventScroll: true });
  }

  function hide() {
    current = null;
    for (const node of overlays.values()) {
      node.classList.remove('is-open');
      node.inert = true;
    }
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (button && current && overlays.get(current).contains(button)) onAction(button.dataset.action);
  });

  return {
    show,
    hide,
    get current() {
      return current;
    },
  };
}
