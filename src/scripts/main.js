// Composition root: boots the session, then routes between login, menus and the game.

import { restoreSession } from './auth.js';
import { fullscreen } from './fullscreen.js';
import { Game } from './game/game.js';
import { store } from './store.js';
import { createBackdrop } from './ui/backdrop.js';
import { createChapters } from './ui/chapters.js';
import { $ } from './ui/dom.js';
import { moveFocus } from './ui/focus-nav.js';
import { createLogin } from './ui/login.js';
import { createMenu } from './ui/menu.js';
import { createPlay } from './ui/play.js';
import { createRouter } from './ui/router.js';
import { createScreens } from './ui/screens.js';
import { guardDoubleActivation } from './ui/settle.js';

const app = $('#app');
guardDoubleActivation(app);
const screens = createScreens(app, { autofocus: !fullscreen.isMobile() });
const backdrop = createBackdrop($('#backdrop', app));
const router = createRouter(render);

const play = createPlay(screens.element('game'), {
  createGame: (canvas, options) => new Game(canvas, options),
  navigate: (route) => router.go(route),
});
const menu = createMenu(screens.element('menu'), { onPlay: startLevel });
const chapters = createChapters(screens.element('chapters'), { onSelect: startLevel });
createLogin(screens.element('login'), { onSignedIn: () => render(router.current()) });

/** Entering a level from a tap: the same gesture takes phones fullscreen. */
function startLevel(level) {
  if (fullscreen.isMobile()) fullscreen.enter();
  router.go({ screen: 'game', level });
}

function render(route) {
  if (!store.user) {
    // The URL is kept, so signing in lands on whatever was asked for.
    play.leave();
    show('login');
    return;
  }
  // A level that does not exist or is still locked: land on the chapters and let its tile say no.
  const denied = route.screen === 'game' && !store.isUnlocked(route.level) ? route.level : route.rejected;
  if (denied !== undefined) {
    router.go({ screen: 'chapters' }, { replace: true });
    chapters.reject(denied, { afterEntrance: true });
    return;
  }
  if (route.screen === 'game') {
    show('game');
    play.enter(route.level);
    return;
  }
  play.leave();
  fullscreen.exit();
  show(route.screen);
}

function show(name) {
  backdrop.setActive(name !== 'game');
  screens.show(name);
}

store.subscribe(() => {
  menu.update();
  chapters.update();
  // Signed out from the menu: show the login screen, with the URL back at the site root.
  const signedOut = !store.user && screens.current !== 'login' && screens.current !== 'boot';
  if (signedOut) router.go({ screen: 'menu' }, { replace: true });
});

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-nav]')?.dataset.nav;
  if (target === 'back') router.back();
  else if (target) router.go({ screen: target });
});

window.addEventListener('keydown', (event) => {
  const scope = screens.current === 'game' ? $('.overlay.is-open', app) : screens.element(screens.current);
  if (scope) moveFocus(scope, event);
  if (event.code === 'Escape' && (screens.current === 'chapters' || screens.current === 'howto')) router.back();
});

// restoreSession never rejects; a restored session reaches the menu and chapters through the store subscription.
restoreSession().then(() => render(router.current()));
