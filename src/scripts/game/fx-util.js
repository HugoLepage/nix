// Colour, sprite and easing helpers shared by the rendering modules.

export const TAU = Math.PI * 2;

const parsed = new Map();
// Radial alpha profiles as [stop, alpha, …]: a hot centre for glows, a wide haze, a flat-topped disc,
// and a broad bloom for screen flashes.
const PROFILES = {
  hot: [0, 1, 0.1, 0.72, 0.28, 0.3, 0.55, 0.09, 1, 0],
  soft: [0, 0.5, 0.35, 0.34, 0.7, 0.1, 1, 0],
  flat: [0, 1, 0.4, 0.92, 0.7, 0.45, 1, 0],
  bloom: [0, 1, 0.18, 0.62, 0.45, 0.24, 0.75, 0.06, 1, 0],
};
const sprites = { hot: new Map(), soft: new Map(), flat: new Map(), bloom: new Map() };
let probe = null;

/** Any CSS colour → [r, g, b] (0–255). Resolved through a 1×1 canvas so every CSS syntax works. */
export function parseColor(css) {
  let rgb = parsed.get(css);
  if (rgb) return rgb;
  if (!probe) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    probe = canvas.getContext('2d', { willReadFrequently: true });
  }
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const data = probe.getImageData(0, 0, 1, 1).data;
  rgb = [data[0], data[1], data[2]];
  parsed.set(css, rgb);
  return rgb;
}

export function rgba(css, alpha) {
  const [r, g, b] = parseColor(css);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Linear blend of two CSS colours as an rgba() string. */
export function mix(a, b, t, alpha = 1) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const ch = (k) => Math.round(ca[k] + (cb[k] - ca[k]) * t);
  return `rgba(${ch(0)}, ${ch(1)}, ${ch(2)}, ${alpha.toFixed(3)})`;
}

/**
 * Cached radial glow sprite, meant to be drawn with 'lighter'. It replaces
 * shadowBlur everywhere: one scaled drawImage instead of a per-frame blur.
 * Profiles: 'hot' (default) for glows, 'soft' for wide haze, 'flat' for a solid disc with a feathered rim,
 * 'bloom' for a flash that lights the screen from one point.
 */
export function glowSprite(color, profile = 'hot') {
  const cache = sprites[profile];
  let sprite = cache.get(color);
  if (sprite) return sprite;
  const size = 128;
  sprite = document.createElement('canvas');
  sprite.width = sprite.height = size;
  const ctx = sprite.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const stops = PROFILES[profile];
  for (let i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], rgba(color, stops[i + 1]));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  cache.set(color, sprite);
  return sprite;
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Frame-rate independent exponential ease of `value` toward `target` at `rate` (1 / s). */
export const approach = (value, target, rate, dt) => value + (target - value) * (1 - Math.exp(-rate * dt));

export const easeOutCubic = (p) => 1 - (1 - p) ** 3;

export function easeOutBack(p, overshoot = 1.70158) {
  const q = p - 1;
  return 1 + q * q * ((overshoot + 1) * q + overshoot);
}

/** Deterministic 0..1 noise from a number: flicker that stays stable within a frame. */
export function hash(n) {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}
