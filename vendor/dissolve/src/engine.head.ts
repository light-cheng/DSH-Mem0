/**
 * dissolve grain engine for the web, from dissolve-ui. This file is yours.
 *
 * Canvas 2D port of the React Native Atlas engine: the variant math (timing, prepare,
 * step) follows src/dissolve/variants/*.ts almost verbatim. Differences with native: color
 * modulation becomes a blend toward a pre tinted copy of the snapshot (o.k = tint amount), and
 * grains are drawn with drawImage on one fixed overlay canvas, created on the first burst.
 *
 * Safe to import during server rendering: nothing touches the DOM until play() or morph() runs.
 *
 * const h = play({ source: canvas, ...rect, preset: 'dust', origin: { x, y } });
 * await h.done;
 */
import { reducedMotion } from './kit';

export const DPR = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1);
const MAX_GRAINS = 5000;
const DEFAULT_END = 1.2;
/** Per grain: lx, ly, r1, r2, r3, r4, delay, life, then the variant's extra slots. */
const BASE = 8;
