// Fullscreen for phones and tablets. iPhone Safari has no Fullscreen API: everything here then degrades to a
// no-op, and the layout (100dvh, PWA meta tags, manifest) covers "Add to Home Screen" instead.

const SMALL_SCREEN = 820; // CSS px on the short side: phones and small tablets

const root = () => document.documentElement;
const fullscreenElement = () => document.fullscreenElement ?? document.webkitFullscreenElement ?? null;

export const fullscreen = {
  /**
   * Touch-first device: coarse pointer without hover, or a small touch screen whose primary pointer is not a mouse
   * or touchpad. The primary pointer, not hover, sets touch laptops apart: some phones with a stylus report hover.
   */
  isMobile() {
    if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return true;
    return (
      navigator.maxTouchPoints > 0 &&
      !window.matchMedia('(pointer: fine)').matches &&
      Math.min(window.screen.width, window.screen.height) <= SMALL_SCREEN
    );
  },

  supported() {
    const enabled = document.fullscreenEnabled ?? document.webkitFullscreenEnabled ?? false;
    return enabled && typeof (root().requestFullscreen ?? root().webkitRequestFullscreen) === 'function';
  },

  active() {
    return fullscreenElement() !== null;
  },

  /**
   * Must be called from a user-activation handler (click, pointerup, keydown). Resolves to whether the page is
   * fullscreen afterwards; never rejects (no API, no activation, or the user declined).
   */
  async enter() {
    if (this.active()) return true;
    if (!this.supported()) return false;
    try {
      const element = root();
      if (element.requestFullscreen) await element.requestFullscreen({ navigationUI: 'hide' });
      else await element.webkitRequestFullscreen();
    } catch {
      // Staying windowed is an acceptable outcome.
    }
    return this.active();
  },

  async exit() {
    if (!this.active()) return;
    try {
      if (document.exitFullscreen) await document.exitFullscreen();
      else await document.webkitExitFullscreen();
    } catch {
      // Already left (the user beat us to it).
    }
  },

  /** `fn(active)` on every change. Returns the unsubscribe function. */
  onChange(fn) {
    // Chromium fires both spellings; listening to one keeps `fn` to a single call per change.
    const type = 'onfullscreenchange' in document ? 'fullscreenchange' : 'webkitfullscreenchange';
    const listener = () => fn(this.active());
    document.addEventListener(type, listener);
    return () => document.removeEventListener(type, listener);
  },
};
