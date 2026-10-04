// Main menu: Start / Continue, and the signed-in user chip.

import { signOut } from '../auth.js';
import { store } from '../store.js';
import { $, pad2 } from './dom.js';

export function createMenu(root, { onPlay }) {
  const label = $('#menu-play-label', root);
  const levelBadge = $('#menu-play-level', root);
  const userName = $('#user-name', root);

  /** Level the big button starts: the furthest unlocked one once there is progress, else the first. */
  const playLevel = () => (store.hasProgress() ? store.continueLevel() : 1);

  function update() {
    const continuing = store.hasProgress();
    label.textContent = continuing ? 'Continue' : 'Start';
    levelBadge.hidden = !continuing;
    levelBadge.textContent = pad2(playLevel());
    userName.textContent = store.user?.name ?? '';
  }

  $('#menu-play', root).addEventListener('click', () => onPlay(playLevel()));
  $('#sign-out', root).addEventListener('click', signOut);

  return { update };
}
