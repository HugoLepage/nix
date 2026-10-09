// In-game HUD: lives (mini arrowheads), level number, the running powers and the bottom progress bar.

import { MAX_LIVES, POWER_TYPES, POWERS, START_LIVES, WIN_FRACTION } from '../config.js';
import { CATALOG } from './catalog.js';
import { $, el, flourish, icon, pad2, prefersReducedMotion, tint } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const COUNT_DURATION = 500; // ms for the % readout to roll to its new value
const COUNT_TICK = 32; // ms between readout updates
const BLINK_LEAD = 2; // seconds before a timed power runs out that its chip starts to blink
const DANGER = '#ff6b86'; // the --danger token: WAAPI keyframes do not resolve var()
const LIFE_GLOW = 'drop-shadow(0 0 6px rgba(127, 220, 255, 0.7))'; // .life's own filter in game.css
// Powers that show a chip: every one but the extra life, which is instant and shows as a life instead.
const CHIP_TYPES = POWER_TYPES.filter((type) => type !== 'life');

export function createHud(root) {
  const livesBox = $('#hud-lives', root);
  const levelValue = $('#hud-level', root);
  const tray = $('#hud-powers', root);
  const bottom = $('.hud-bottom', root);
  const bar = $('#progress', root);
  const fill = $('#progress-fill', root);
  const readout = $('#progress-value', root);

  const lives = Array.from({ length: MAX_LIVES }, () => icon('i-arrowhead', 'life'));
  livesBox.append(...lives);
  const chips = new Map(); // power type → { node, left } while it runs; `left` is the seconds it had at the last update

  let slots = START_LIVES; // life slots shown: extra lives add one, and it stays for the rest of the attempt
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
    const shown = Math.min(MAX_LIVES, Math.max(0, Math.floor(count) || 0));
    slots = Math.max(slots, shown);
    livesBox.setAttribute('aria-label', `${shown} ${shown === 1 ? 'life' : 'lives'}`);
    lives.forEach((life, index) => {
      const lost = index >= shown;
      const wasShown = !life.hasAttribute('hidden');
      life.toggleAttribute('hidden', index >= slots);
      if (animate && lost && wasShown && !life.classList.contains('is-lost')) {
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
      } else if (animate && !lost && (!wasShown || life.classList.contains('is-lost'))) {
        // An extra life: the arrowhead pops into its slot and settles into the glow game.css gives it.
        flourish(
          life,
          [
            { transform: 'scale(0)', opacity: 0, filter: `brightness(3) ${LIFE_GLOW}` },
            { transform: 'scale(1.7)', opacity: 1, filter: `brightness(2.4) ${LIFE_GLOW}`, offset: 0.45 },
            { transform: 'scale(1)', opacity: 1, filter: `brightness(1) ${LIFE_GLOW}` },
          ],
          { duration: 600, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
        );
      }
      life.classList.toggle('is-lost', lost);
    });
  }

  /** `fraction` is the captured share of the board (0..1); the bar is full at WIN_FRACTION. It can also fall back. */
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
    const falling = percent < targetPercent;
    countTo(percent);
    if (falling) {
      // Land lost to a chipper: the readout dips and flushes red, the bar flares red as it shrinks.
      flourish(
        readout,
        [
          { transform: 'scale(1)', color: DANGER },
          { transform: 'scale(0.8)', color: DANGER, offset: 0.3 },
          { transform: 'scale(1)' },
        ],
        { duration: 900, easing: 'ease-out' },
      );
      flourish(
        fill,
        [{ filter: 'saturate(0.3) brightness(1.5)', boxShadow: '0 0 20px rgba(255, 107, 134, 0.95)' }, {}],
        { duration: 1000, easing: 'ease-out' },
      );
      return;
    }
    flourish(
      readout,
      [{ transform: 'scale(1)' }, { transform: 'scale(1.45)', offset: 0.3 }, { transform: 'scale(1)' }],
      { duration: 520, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
    );
    flourish(fill, [{ filter: 'brightness(2.2)' }, { filter: 'brightness(1)' }], { duration: 700, easing: 'ease-out' });
  }

  // ── Powers ───────────────────────────────────────────────────────────────

  /**
   * A chip's face: the glyph inside a ring. A timed power's ring drains from `left` seconds (CSS runs it, paused
   * whenever the game is); the shield's and the armed cut's rings stay full. Rebuilt on every update, which restarts the CSS
   * animations exactly where the game's own timer stands.
   */
  function chipBody(type, left) {
    const timed = POWERS[type].duration > 0;
    const body = el('span', `power-body ${timed ? 'is-timed' : 'is-armed'}`);
    const ring = document.createElementNS(SVG_NS, 'svg');
    ring.setAttribute('class', 'power-ring');
    ring.setAttribute('viewBox', '0 0 30 30');
    ring.setAttribute('aria-hidden', 'true');
    for (const name of ['power-track', 'power-left']) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('class', name);
      circle.setAttribute('cx', '15');
      circle.setAttribute('cy', '15');
      circle.setAttribute('r', '13.5');
      circle.setAttribute('pathLength', '100');
      ring.append(circle);
    }
    if (timed) {
      const { duration } = POWERS[type];
      const remaining = Math.min(duration, Math.max(0, left));
      body.style.setProperty('--duration', `${duration}s`);
      body.style.setProperty('--delay', `${(remaining - duration).toFixed(3)}s`);
      body.style.setProperty('--blink', `${(remaining - BLINK_LEAD).toFixed(3)}s`);
    }
    body.append(ring, icon(CATALOG[type].icon, 'power-icon'));
    return body;
  }

  function addChip(type, left, animate) {
    const entry = CATALOG[type];
    const chip = el('span', 'power');
    chip.dataset.power = type;
    chip.style.order = String(CHIP_TYPES.indexOf(type));
    chip.style.setProperty('--accent', entry.color);
    chip.style.setProperty('--accent-glow', tint(entry.color, 0.5));
    chip.append(chipBody(type, left));
    chips.set(type, { node: chip, left });
    tray.append(chip);
    if (animate) {
      flourish(
        chip,
        [
          { transform: 'scale(0.2)', opacity: 0 },
          { transform: 'scale(1.3)', opacity: 1, offset: 0.5 },
          { transform: 'scale(1)', opacity: 1 },
        ],
        { duration: 520, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
      );
    }
  }

  /** The power ended, was used up or was taken by a death: its chip bursts and goes. */
  function dropChip(type, animate) {
    const chip = chips.get(type).node;
    chips.delete(type);
    const done = () => {
      chip.remove();
      if (chips.size === 0 && !tray.querySelector('.power')) tray.hidden = true;
    };
    if (!animate || prefersReducedMotion() || !chip.animate) return done();
    chip
      .animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.6)', opacity: 0 }], {
        duration: 300,
        easing: 'ease-out',
        fill: 'forwards',
      })
      .finished.then(done, done);
  }

  /**
   * `powers` is the game's snapshot: { speed, freeze, slow } in seconds left (0 = off), `shield` = up, `cut` = armed.
   * Anything missing counts as off, so `setPowers(null)` clears the tray.
   */
  function setPowers(powers, { animate = true } = {}) {
    for (const type of CHIP_TYPES) {
      const value = powers?.[type];
      const timed = POWERS[type].duration > 0;
      const on = timed ? Number.isFinite(value) && value > 0 : value === true;
      const chip = chips.get(type);
      if (!on) {
        if (chip) dropChip(type, animate);
        continue;
      }
      const left = timed ? value : 0;
      if (!chip) {
        addChip(type, left, animate);
        continue;
      }
      // Picked up again while it ran: the timer is full again, and the chip says so.
      if (animate && timed && left > chip.left + 0.5) {
        flourish(
          chip.node,
          [{ transform: 'scale(1)' }, { transform: 'scale(1.35)', offset: 0.35 }, { transform: 'scale(1)' }],
          { duration: 480, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
        );
      }
      chip.left = left;
      chip.node.firstChild.replaceWith(chipBody(type, left));
    }
    const running = CHIP_TYPES.filter((type) => chips.has(type));
    if (running.length) tray.hidden = false;
    tray.setAttribute('aria-label', `Powers: ${running.map((type) => CATALOG[type].name).join(', ')}`);
  }

  /** Fresh level attempt: everything snaps to its starting value without flourishes. */
  function reset(level, lifeCount) {
    levelValue.textContent = pad2(level);
    fill.style.transition = 'none';
    slots = START_LIVES;
    setLives(lifeCount, { animate: false });
    setProgress(0, { animate: false });
    setPowers(null, { animate: false });
    void fill.offsetWidth; // commit the zero width before transitions come back
    fill.style.transition = '';
  }

  setLives(START_LIVES, { animate: false });

  return { reset, setLives, setProgress, setPowers };
}
