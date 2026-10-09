// Screen switching for `#app[data-screen]`. Every screen stays laid out (the game canvas needs a real box before it
// is shown); CSS cross-fades on `.is-active`, and `inert` keeps the hidden ones out of tab order and the a11y tree.

import { reveal } from './dom.js';
import { markSwitch } from './settle.js';

/**
 * `autofocus: false` leaves focus alone on arrival: on phones a focused field pops the keyboard open, and a focus
 * ring on the first button would be noise without a keyboard to drive it.
 */
export function createScreens(app, { autofocus = true } = {}) {
  const screens = new Map([...app.querySelectorAll('.screen')].map((node) => [node.dataset.screen, node]));

  function show(name) {
    if (!screens.has(name)) throw new Error(`Unknown screen: ${name}`);
    if (app.dataset.screen === name) return;
    for (const [key, node] of screens) {
      node.classList.toggle('is-active', key === name);
      node.inert = key !== name;
    }
    app.dataset.screen = name;
    markSwitch();
    const target = screens.get(name).querySelector('[data-autofocus]:not([hidden])');
    if (autofocus && target) target.focus({ preventScroll: true });
    else document.activeElement?.blur?.();
    // Focused or not, the element a screen opens on is brought into view: on a long chapter list, the level to play.
    if (target) reveal(target, { center: true });
  }

  return {
    show,
    get current() {
      return app.dataset.screen;
    },
    element: (name) => screens.get(name),
  };
}
