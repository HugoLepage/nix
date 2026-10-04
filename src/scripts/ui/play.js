// A play session: one Game on the canvas, wired to the HUD, the overlays, input, fullscreen and saved progress.

import { LEVEL_COUNT } from '../config.js';
import { fullscreen } from '../fullscreen.js';
import { createInput } from '../input.js';
import { store } from '../store.js';
import { $, vibrate } from './dom.js';
import { createHud } from './hud.js';
import { createOverlays } from './overlays.js';

// The game announces 'win' / 'lose' the moment they happen; the overlays wait for the fireworks to play out.
const WIN_OVERLAY_DELAY = 1400;
const LOSE_OVERLAY_DELAY = 1300;

let software;
/** No GPU behind the canvas (blocklisted driver, VM, remote desktop): the full effects would drop frames there. */
function softwareRendered() {
  if (software === undefined) {
    const gl = document.createElement('canvas').getContext('webgl', { failIfMajorPerformanceCaveat: true });
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    software = !gl;
  }
  return software;
}

/**
 * `createGame(canvas, options)` builds a Game (injected by main.js); `navigate(route)` changes screen.
 * Returns `{ enter(level), leave() }`. A session lasts from `enter` until `leave` or the next `enter`.
 */
export function createPlay(root, { createGame, navigate }) {
  const canvas = $('#game-canvas', root);
  const hud = createHud(root);
  const overlays = createOverlays(root, { onAction });
  let session = null;

  const actions = {
    resume,
    restart() {
      clearTimeout(session.timer);
      session.game.restart();
      showIntro();
    },
    next: () => navigate({ screen: 'game', level: session.level + 1 }),
    chapters: () => navigate({ screen: 'chapters' }),
    menu: () => navigate({ screen: 'menu' }),
  };

  function onAction(name) {
    if (session) actions[name]?.();
  }

  function enter(level) {
    leave();
    const lowPower = fullscreen.isMobile() || (navigator.hardwareConcurrency ?? 8) <= 2 || softwareRendered();
    const game = createGame(canvas, { lowPower });
    const listeners = new AbortController();
    session = { game, level, listeners, timer: 0, lives: 0, opening: null };
    const unsubscribe = [
      game.on('state', onState),
      game.on('lives', onLives),
      game.on('progress', onProgress),
      game.on('qixDestroyed', () => vibrate([15, 30, 15])),
      game.on('win', onWin),
      game.on('lose', onLose),
    ];
    const input = createInput({
      target: root,
      onDirection(direction) {
        // A swipe or key on the intro is remembered: it steers as soon as play begins.
        if (game.state === 'intro') session.opening = direction;
        game.input(direction);
      },
      onPause: togglePause,
      onAny: dismissIntro,
    });
    listeners.signal.addEventListener('abort', () => {
      input.destroy();
      for (const off of unsubscribe) off();
    });
    // Until the first move, a rotated phone or a fullscreen switch gets a board shaped for the new box;
    // afterwards the game only re-fits (letterboxes) the board it has.
    window.addEventListener('resize', reshape, { signal: listeners.signal });
    // The game pauses itself only when the page is hidden. A window that stays visible but lost focus (another window
    // or monitor now gets the keys) would let the player run on unsteered.
    window.addEventListener('blur', pause, { signal: listeners.signal });
    game.load(level);
    showIntro();
  }

  function leave() {
    if (!session) return;
    clearTimeout(session.timer);
    session.listeners.abort();
    session.game.stop();
    session = null;
    overlays.hide();
    delete root.dataset.state;
  }

  function reshape() {
    if (session.game.state === 'intro') session.game.load(session.level);
  }

  function showIntro() {
    const { game, level } = session;
    root.dataset.state = game.state;
    session.lives = game.lives;
    session.opening = null;
    hud.reset(level, game.lives);
    overlays.show('intro', { level });
  }

  function onState({ state }) {
    root.dataset.state = state;
    if (state === 'intro') showIntro();
    else if (state === 'paused') overlays.show('pause');
    // A pause taken during the death pause resumes into the rest of it.
    else if (state === 'playing' || state === 'dying') overlays.hide();
  }

  function onLives({ lives }) {
    if (lives < session.lives) vibrate([30, 40, 60]);
    session.lives = lives;
    hud.setLives(lives);
  }

  function onProgress({ fraction, gained }) {
    if (gained > 0) vibrate(12);
    hud.setProgress(fraction);
  }

  function onWin({ level, time, fraction }) {
    const key = `l${level}`;
    const previous = store.progress.best[key];
    store.recordWin(level, time);
    const best = previous === undefined || store.progress.best[key] < previous;
    vibrate([20, 40, 20, 40, 80]);
    session.timer = setTimeout(
      () => overlays.show('win', { time, fraction, best, last: level >= LEVEL_COUNT }),
      WIN_OVERLAY_DELAY,
    );
  }

  function onLose() {
    session.timer = setTimeout(() => overlays.show('lose'), LOSE_OVERLAY_DELAY);
  }

  /** First key or tap of a level: also the user gesture that takes phones fullscreen. */
  async function dismissIntro() {
    const current = session;
    if (current?.game.state !== 'intro') return;
    // Waiting for the switch lets `reshape` rebuild the board for the fullscreen box before play begins.
    if (fullscreen.isMobile()) await fullscreen.enter();
    if (session !== current || current.game.state !== 'intro') return;
    store.markStarted(current.level);
    current.game.begin();
    if (current.opening) current.game.input(current.opening);
  }

  async function resume() {
    const current = session;
    if (fullscreen.isMobile()) await fullscreen.enter();
    if (session === current && current.game.state === 'paused') current.game.resume();
  }

  /** In play or during the death pause (the game ignores it anywhere else): the player must never respawn unseen. */
  function pause() {
    session?.game.pause();
  }

  /**
   * Escape / P (`code`) pause and resume in play. Elsewhere only Escape leaves, for the menu: P is for pause, so on
   * the intro it is just another key, and during the win fireworks it must not throw the result card away.
   */
  function togglePause(code) {
    const { state } = session.game;
    if (state === 'playing' || state === 'dying') pause();
    else if (state === 'paused') resume();
    else if (state === 'intro' && code === 'KeyP') dismissIntro();
    else if (code !== 'KeyP') actions.menu();
  }

  $('#hud-pause', root).addEventListener('click', pause);

  // Losing fullscreen mid-play (back gesture, notification, rotation lock prompt…) must not cost a life.
  fullscreen.onChange((active) => {
    if (!active) pause();
  });

  return { enter, leave };
}
