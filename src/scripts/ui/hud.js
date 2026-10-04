// In-game HUD: lives (mini arrowheads), level number and the bottom progress bar.

import { START_LIVES, WIN_FRACTION } from '../config.js';
import { $, flourish, icon, pad2 } from './dom.js';

const COUNT_DURATION = 500; // ms for the % readout to roll to its new value
const COUNT_TICK = 32; // ms between readout updates

export function createHud(root) {
  const livesBox = $('#hud-lives', root);
  const levelValue = $('#hud-level', root);
  const bottom = $('.hud-bottom', root);
  const bar = $('#progress', root);
  const fill = $('#progress-fill', root);
  const readout = $('#progress-value', root);

  const lives = Array.from({ length: START_LIVES }, () => icon('i-arrowhead', 'life'));
  livesBox.append(...lives);

  let shownPercent = 0;
  let targetPercent = 0;
  let countTimer = 0;

  function showPercent(value) {
    shownPercent = value;
    readout.textContent = `${Math.round(value)}%`;
  }

  /** Rolls the readout to `target`. Timer-driven so the number still lands when frames are throttled. */
  function countTo(target) {
    clearInterval(countTimer);
    targetPercent = target;
    const from = shownPercent;
    const start = performance.now();
    countTimer = setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / COUNT_DURATION);
      showPercent(from + (target - from) * (1 - (1 - t) ** 3));
      if (t === 1) clearInterval(countTimer);
    }, COUNT_TICK);
  }

  function setLives(count, { animate = true } = {}) {
    livesBox.setAttribute('aria-label', `${count} lives`);
    lives.forEach((life, index) => {
      const lost = index >= count;
      if (lost && animate && !life.classList.contains('is-lost')) {
        flourish(
          life,
          [
            { transform: 'scale(1)', opacity: 1, filter: 'brightness(1)' },
            { transform: 'scale(2.1)', opacity: 1, filter: 'brightness(3)', offset: 0.25 },
            { transform: 'scale(0.4)', opacity: 0, filter: 'brightness(1)', offset: 0.6 },
            { transform: 'scale(0.78)', opacity: 0.16, filter: 'grayscale(1)' },
          ],
          { duration: 650, easing: 'ease-out' },
        );
      }
      life.classList.toggle('is-lost', lost);
    });
  }

  /** `fraction` is the captured share of the board (0..1); the bar is full at WIN_FRACTION. */
  function setProgress(fraction, { animate = true } = {}) {
    const safe = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    const toGoal = Math.min(1, safe / WIN_FRACTION);
    // The epsilon keeps binary noise (0.29 * 100 = 28.999…) from showing one percent short.
    const percent = Math.floor(safe * 100 + 1e-9);
    fill.style.width = `${toGoal * 100}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(toGoal * 100)));
    bottom.classList.toggle('is-full', toGoal >= 1);
    if (!animate) {
      clearInterval(countTimer);
      targetPercent = percent;
      showPercent(percent);
      return;
    }
    if (percent === targetPercent) return;
    countTo(percent);
    flourish(
      readout,
      [{ transform: 'scale(1)' }, { transform: 'scale(1.45)', offset: 0.3 }, { transform: 'scale(1)' }],
      { duration: 520, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
    );
    flourish(fill, [{ filter: 'brightness(2.2)' }, { filter: 'brightness(1)' }], { duration: 700, easing: 'ease-out' });
  }

  /** Fresh level attempt: everything snaps to its starting value without flourishes. */
  function reset(level, lifeCount) {
    levelValue.textContent = pad2(level);
    fill.style.transition = 'none';
    setLives(lifeCount, { animate: false });
    setProgress(0, { animate: false });
    void fill.offsetWidth; // commit the zero width before transitions come back
    fill.style.transition = '';
  }

  return { reset, setLives, setProgress };
}
