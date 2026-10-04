// Screen switching for `#app[data-screen]`. Every screen stays laid out (the game canvas needs a real box before it
// is shown); CSS cross-fades on `.is-active`, and `inert` keeps the hidden ones out of tab order and the a11y tree.

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
    const target = autofocus ? screens.get(name).querySelector('[data-autofocus]:not([hidden])') : null;
    if (target) target.focus({ preventScroll: true });
    else document.activeElement?.blur?.();
  }

  return {
    show,
    get current() {
      return app.dataset.screen;
    },
    element: (name) => screens.get(name),
  };
}
