// Ambient canvas behind the menus: a slow qix-like ribbon of light and drifting dust, both at very low alpha.
// Every frame is a pure function of time, so nothing accumulates and a still frame is always well-formed.

import { COLORS } from '../config.js';
import { prefersReducedMotion } from './dom.js';

const MAX_DPR = 1.5;
const RIBBON_SEGMENTS = 44;
const RIBBON_STEP = 0.11; // seconds of history between neighbouring segments
const DUST_COUNT = 70;
const STILL_TIME = 40; // the moment shown when motion is reduced

/** Deterministic 0..1 noise per index, so the dust needs no stored state. */
const hash = (n) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export function createBackdrop(canvas) {
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let frame = 0;
  let running = false;
  let wanted = false;

  function resize() {
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!running) draw(STILL_TIME);
  }

  function drawRibbon(time) {
    ctx.lineWidth = 1.2;
    for (let i = 0; i < RIBBON_SEGMENTS; i++) {
      const t = time - i * RIBBON_STEP;
      const age = i / RIBBON_SEGMENTS;
      // One end roams the left half, the other the right, so the ribbon always spans the screen.
      const ax = width * (0.3 + 0.24 * Math.sin(t * 0.21 + 1.3) + 0.08 * Math.sin(t * 0.53));
      const ay = height * (0.5 + 0.34 * Math.cos(t * 0.17) + 0.1 * Math.cos(t * 0.61 + 2.1));
      const bx = width * (0.7 + 0.24 * Math.cos(t * 0.19 + 0.4) + 0.08 * Math.sin(t * 0.47 + 4.0));
      const by = height * (0.5 + 0.34 * Math.sin(t * 0.23 + 2.6) + 0.1 * Math.cos(t * 0.71));
      ctx.globalAlpha = 0.16 * (1 - age) ** 1.6;
      ctx.strokeStyle = COLORS.ice[age < 0.25 ? 0 : age < 0.6 ? 2 : 3];
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
  }

  function drawDust(time) {
    ctx.fillStyle = COLORS.ice[0];
    for (let i = 0; i < DUST_COUNT; i++) {
      const depth = 0.35 + hash(i) * 0.65;
      const rise = (hash(i + 0.5) + time * 0.006 * depth) % 1;
      const x = (hash(i + 0.25) + 0.012 * Math.sin(time * 0.13 + i)) * width;
      const y = (1 - rise) * (height + 20) - 10;
      const twinkle = 0.55 + 0.45 * Math.sin(time * (0.4 + hash(i + 0.75)) + i * 1.7);
      ctx.globalAlpha = 0.34 * depth * twinkle;
      ctx.beginPath();
      ctx.arc(x, y, 0.5 + depth * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function draw(time) {
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';
    drawRibbon(time);
    drawDust(time);
  }

  function tick(now) {
    draw(now / 1000);
    frame = requestAnimationFrame(tick);
  }

  /** Runs only while wanted, visible and allowed to move; otherwise a still frame stays on the canvas. */
  function sync() {
    const shouldRun = wanted && !document.hidden && !prefersReducedMotion();
    if (shouldRun === running) return;
    running = shouldRun;
    if (running) frame = requestAnimationFrame(tick);
    else cancelAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', sync);
  resize();

  return {
    /** The game screen switches the backdrop off; every menu screen switches it back on. */
    setActive(active) {
      wanted = active;
      sync();
    },
  };
}
