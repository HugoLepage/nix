// Query-string router on top of the History API. Navigation never reloads the page: a reload would drop fullscreen.
//   (no params) → menu      ?view=chapters | ?view=howto → that screen      ?level=N → play level N

import { LEVEL_COUNT } from '../config.js';

const VIEWS = ['chapters', 'howto'];

/**
 * Location search → route. A `level` that is not one of the game's levels becomes the chapters route with
 * `rejected` set to the level that was asked for (NaN when it was not a number at all).
 */
export function parseRoute(search) {
  const params = new URLSearchParams(search);
  if (params.has('level')) {
    const raw = params.get('level');
    const level = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
    if (level >= 1 && level <= LEVEL_COUNT) return { screen: 'game', level };
    return { screen: 'chapters', rejected: level };
  }
  const view = params.get('view');
  return { screen: VIEWS.includes(view) ? view : 'menu' };
}

/** Route → URL relative to the current page, so the site's base path never matters. */
export function routeUrl(route) {
  if (route.screen === 'game') return `?level=${route.level}`;
  if (VIEWS.includes(route.screen)) return `?view=${route.screen}`;
  return window.location.pathname;
}

const sameRoute = (a, b) => a.screen === b.screen && a.level === b.level;

/**
 * `onChange(route)` runs after every navigation, including back / forward.
 * Each history entry remembers how many in-app entries lie beneath it, so `back()` never walks off the site, and
 * which screen the one right beneath it shows.
 */
export function createRouter(onChange) {
  const current = () => parseRoute(window.location.search);
  const depth = () => window.history.state?.depth ?? 0;
  const below = () => window.history.state?.below;

  function go(route, { replace = false } = {}) {
    if (replace) window.history.replaceState({ depth: depth(), below: below() }, '', routeUrl(route));
    else if (!sameRoute(route, current())) {
      window.history.pushState({ depth: depth() + 1, below: current().screen }, '', routeUrl(route));
    }
    onChange(current());
  }

  /**
   * The in-app back arrow (and Escape). It never pops into a game: a level left behind (say, the last one, cleared,
   * then its Chapters button) would restart. The browser's own Back still returns to it.
   */
  function back(fallback = { screen: 'menu' }) {
    if (depth() > 0 && below() !== 'game') window.history.back();
    else go(fallback, { replace: true });
  }

  window.addEventListener('popstate', () => onChange(current()));

  return { current, go, back };
}
