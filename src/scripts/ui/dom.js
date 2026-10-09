// Small DOM helpers shared by the UI modules.

const SVG_NS = 'http://www.w3.org/2000/svg';

export const $ = (selector, root = document) => root.querySelector(selector);

/** `document.createElement` with a class name and optional text. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** An `<svg>` that instantiates one of the symbols defined in Defs.astro. */
export function icon(symbolId, className = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${symbolId}`);
  svg.append(use);
  return svg;
}

/** `#rrggbb` at `alpha`, as an `rgba()` string: glows and rims in an enemy's or a power's own colour. */
export function tint(hex, alpha) {
  const value = Number.parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(value)) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * One-shot flourish through the Web Animations API, so it can be re-triggered at will and never fights the CSS
 * entrance animations for the `animation` property. Skipped when the user asked for reduced motion.
 */
export function flourish(element, keyframes, options) {
  if (prefersReducedMotion() || !element.animate) return;
  element.animate(keyframes, options);
}

/**
 * The "no" gesture: a quick horizontal shake, optionally after `delay` ms. With reduced motion it is a red flash of
 * the border and glow instead, so the answer still shows without anything moving.
 */
export function shake(element, delay = 0) {
  if (prefersReducedMotion()) {
    // Literal colours: WAAPI keyframes do not resolve var(); this is the --danger token.
    element.animate?.(
      [{ borderColor: '#ff6b86', boxShadow: '0 0 18px rgba(255, 107, 134, 0.45)' }, {}],
      { duration: 600, delay, easing: 'ease-out' },
    );
    return;
  }
  flourish(
    element,
    { transform: ['translateX(0)', 'translateX(-9px)', 'translateX(8px)', 'translateX(-6px)', 'translateX(4px)', 'translateX(0)'] },
    { duration: 420, delay, easing: 'cubic-bezier(0.36, 0.07, 0.19, 0.97)' },
  );
}

/**
 * Scrolls the screen holding `element` just enough to show it whole, clear of the screen's padding (and so of the
 * safe areas), or with `center` to bring it to the middle. Positions are read from layout, so an entrance transform
 * still in flight cannot skew them, and only the `.screen` scrolls: the app shell around it never moves.
 */
export function reveal(element, { center = false, smooth = false } = {}) {
  const scroller = element?.closest('.screen');
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
  const style = getComputedStyle(scroller);
  // The game screen clips instead of scrolling: script must not scroll it either.
  if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') return;
  let top = 0;
  let node = element;
  for (; node && node !== scroller; node = node.offsetParent) top += node.offsetTop;
  if (node !== scroller) return;
  const padTop = parseFloat(style.paddingTop) || 0;
  const padBottom = parseFloat(style.paddingBottom) || 0;
  const view = scroller.clientHeight;
  const bottom = top + element.offsetHeight;
  const { scrollTop } = scroller;
  let target;
  if (center) target = (top + bottom - view) / 2;
  else if (top < scrollTop + padTop) target = top - padTop;
  else if (bottom > scrollTop + view - padBottom) target = bottom + padBottom - view;
  else return;
  target = Math.max(0, Math.min(scroller.scrollHeight - view, Math.round(target)));
  if (Math.abs(target - scrollTop) < 1) return;
  scroller.scrollTo({ top: target, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
}

export const pad2 = (n) => String(n).padStart(2, '0');

/** Seconds → `m:ss.d` (tenths, matching the precision progress is stored with). */
export function formatTime(seconds) {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(tenths / 600);
  const rest = tenths - minutes * 600;
  return `${minutes}:${pad2(Math.floor(rest / 10))}.${rest % 10}`;
}

/** Tiny haptic tick; silently unavailable on desktop and iOS. */
export function vibrate(pattern) {
  // Chromium blocks (and logs) vibration before the first user gesture.
  if (navigator.userActivation?.hasBeenActive === false) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Some embedded browsers throw instead of returning false.
  }
}
