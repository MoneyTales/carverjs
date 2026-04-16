import type { EasingFn, EasingPreset, EasingInput } from "../types";

// ─── Pre-computed constants ──────────────────────────────────────────────────

const PI = Math.PI;
const HALF_PI = PI / 2;
const c1 = 1.70158;
const c3 = c1 + 1;
const c2 = c1 * 1.525;
const c4 = (2 * PI) / 3;
const c5 = (2 * PI) / 4.5;
const n1 = 7.5625;
const d1 = 2.75;

// ─── 33 Robert Penner Easing Functions + Spring ──────────────────────────────

function linear(t: number): number {
  return t;
}

// Quad
function quadIn(t: number): number {
  return t * t;
}
function quadOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}
function quadInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) * (-2 * t + 2) / 2;
}

// Cubic
function cubicIn(t: number): number {
  return t * t * t;
}
function cubicOut(t: number): number {
  return 1 - (1 - t) * (1 - t) * (1 - t);
}
function cubicInOut(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - (-2 * t + 2) * (-2 * t + 2) * (-2 * t + 2) / 2;
}

// Quart
function quartIn(t: number): number {
  return t * t * t * t;
}
function quartOut(t: number): number {
  return 1 - (1 - t) * (1 - t) * (1 - t) * (1 - t);
}
function quartInOut(t: number): number {
  return t < 0.5
    ? 8 * t * t * t * t
    : 1 - (-2 * t + 2) * (-2 * t + 2) * (-2 * t + 2) * (-2 * t + 2) / 2;
}

// Quint
function quintIn(t: number): number {
  return t * t * t * t * t;
}
function quintOut(t: number): number {
  return 1 - (1 - t) * (1 - t) * (1 - t) * (1 - t) * (1 - t);
}
function quintInOut(t: number): number {
  return t < 0.5
    ? 16 * t * t * t * t * t
    : 1 -
        (-2 * t + 2) *
          (-2 * t + 2) *
          (-2 * t + 2) *
          (-2 * t + 2) *
          (-2 * t + 2) /
          2;
}

// Sine
function sineIn(t: number): number {
  return 1 - Math.cos(t * HALF_PI);
}
function sineOut(t: number): number {
  return Math.sin(t * HALF_PI);
}
function sineInOut(t: number): number {
  return -(Math.cos(PI * t) - 1) / 2;
}

// Expo
function expoIn(t: number): number {
  return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
}
function expoOut(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}
function expoInOut(t: number): number {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return t < 0.5
    ? Math.pow(2, 20 * t - 10) / 2
    : (2 - Math.pow(2, -20 * t + 10)) / 2;
}

// Circ
function circIn(t: number): number {
  return 1 - Math.sqrt(1 - t * t);
}
function circOut(t: number): number {
  return Math.sqrt(1 - (t - 1) * (t - 1));
}
function circInOut(t: number): number {
  return t < 0.5
    ? (1 - Math.sqrt(1 - (2 * t) * (2 * t))) / 2
    : (Math.sqrt(1 - (-2 * t + 2) * (-2 * t + 2)) + 1) / 2;
}

// Back
function backIn(t: number): number {
  return c3 * t * t * t - c1 * t * t;
}
function backOut(t: number): number {
  return 1 + c3 * (t - 1) * (t - 1) * (t - 1) + c1 * (t - 1) * (t - 1);
}
function backInOut(t: number): number {
  return t < 0.5
    ? ((2 * t) * (2 * t) * ((c2 + 1) * 2 * t - c2)) / 2
    : ((2 * t - 2) * (2 * t - 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
}

// Elastic
function elasticIn(t: number): number {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * c4);
}
function elasticOut(t: number): number {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
}
function elasticInOut(t: number): number {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return t < 0.5
    ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
    : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1;
}

// Bounce
function bounceOut(t: number): number {
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}
function bounceIn(t: number): number {
  return 1 - bounceOut(1 - t);
}
function bounceInOut(t: number): number {
  return t < 0.5
    ? (1 - bounceOut(1 - 2 * t)) / 2
    : (1 + bounceOut(2 * t - 1)) / 2;
}

// Spring (damped harmonic oscillator)
function spring(t: number): number {
  return 1 - Math.exp(-6.9 * t) * Math.cos(6.9 * t);
}

// ─── Preset Map ──────────────────────────────────────────────────────────────

const EASING_MAP: Record<EasingPreset, EasingFn> = {
  linear,
  "quad.in": quadIn,
  "quad.out": quadOut,
  "quad.inOut": quadInOut,
  "cubic.in": cubicIn,
  "cubic.out": cubicOut,
  "cubic.inOut": cubicInOut,
  "quart.in": quartIn,
  "quart.out": quartOut,
  "quart.inOut": quartInOut,
  "quint.in": quintIn,
  "quint.out": quintOut,
  "quint.inOut": quintInOut,
  "sine.in": sineIn,
  "sine.out": sineOut,
  "sine.inOut": sineInOut,
  "expo.in": expoIn,
  "expo.out": expoOut,
  "expo.inOut": expoInOut,
  "circ.in": circIn,
  "circ.out": circOut,
  "circ.inOut": circInOut,
  "back.in": backIn,
  "back.out": backOut,
  "back.inOut": backInOut,
  "elastic.in": elasticIn,
  "elastic.out": elasticOut,
  "elastic.inOut": elasticInOut,
  "bounce.in": bounceIn,
  "bounce.out": bounceOut,
  "bounce.inOut": bounceInOut,
  spring,
};

// ─── Cubic Bezier Factory ────────────────────────────────────────────────────

const BEZIER_SAMPLES = 11;
const BEZIER_STEP = 1.0 / (BEZIER_SAMPLES - 1);
const NEWTON_ITERATIONS = 4;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_PRECISION = 0.0000001;
const SUBDIVISION_MAX_ITERATIONS = 10;

function calcBezier(aT: number, a1: number, a2: number): number {
  return ((((1.0 - 3.0 * a2 + 3.0 * a1) * aT + (3.0 * a2 - 6.0 * a1)) * aT) + (3.0 * a1)) * aT;
}

function getSlope(aT: number, a1: number, a2: number): number {
  return 3.0 * (1.0 - 3.0 * a2 + 3.0 * a1) * aT * aT + 2.0 * (3.0 * a2 - 6.0 * a1) * aT + (3.0 * a1);
}

function binarySubdivide(aX: number, aA: number, aB: number, x1: number, x2: number): number {
  let currentX: number;
  let currentT: number;
  let i = 0;
  do {
    currentT = aA + (aB - aA) / 2.0;
    currentX = calcBezier(currentT, x1, x2) - aX;
    if (currentX > 0.0) {
      aB = currentT;
    } else {
      aA = currentT;
    }
  } while (Math.abs(currentX) > SUBDIVISION_PRECISION && ++i < SUBDIVISION_MAX_ITERATIONS);
  return currentT;
}

function newtonRaphson(aX: number, aGuessT: number, x1: number, x2: number): number {
  for (let i = 0; i < NEWTON_ITERATIONS; ++i) {
    const slope = getSlope(aGuessT, x1, x2);
    if (slope === 0.0) return aGuessT;
    const currentX = calcBezier(aGuessT, x1, x2) - aX;
    aGuessT -= currentX / slope;
  }
  return aGuessT;
}

/**
 * Create a cubic bezier easing function (CSS transition compatible).
 * Pre-computes a sample table for fast runtime evaluation.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  // Linear shortcut
  if (x1 === y1 && x2 === y2) return linear;

  const sampleValues = new Float32Array(BEZIER_SAMPLES);
  for (let i = 0; i < BEZIER_SAMPLES; ++i) {
    sampleValues[i] = calcBezier(i * BEZIER_STEP, x1, x2);
  }

  function getTForX(aX: number): number {
    let intervalStart = 0.0;
    let currentSample = 1;
    const lastSample = BEZIER_SAMPLES - 1;

    for (; currentSample !== lastSample && sampleValues[currentSample] <= aX; ++currentSample) {
      intervalStart += BEZIER_STEP;
    }
    --currentSample;

    const dist = (aX - sampleValues[currentSample]) / (sampleValues[currentSample + 1] - sampleValues[currentSample]);
    const guessForT = intervalStart + dist * BEZIER_STEP;

    const initialSlope = getSlope(guessForT, x1, x2);
    if (initialSlope >= NEWTON_MIN_SLOPE) {
      return newtonRaphson(aX, guessForT, x1, x2);
    }
    if (initialSlope === 0.0) {
      return guessForT;
    }
    return binarySubdivide(aX, intervalStart, intervalStart + BEZIER_STEP, x1, x2);
  }

  return (t: number): number => {
    if (t === 0) return 0;
    if (t === 1) return 1;
    return calcBezier(getTForX(t), y1, y2);
  };
}

// ─── Steps Factory ───────────────────────────────────────────────────────────

/**
 * Step easing function (like CSS steps()).
 * @param count Number of steps
 * @param jumpEnd If true, output jumps at the end of each interval. Default: true
 */
export function steps(count: number, jumpEnd = true): EasingFn {
  return (t: number): number => {
    if (jumpEnd) {
      return Math.min(Math.floor(t * count), count) / count;
    }
    return Math.ceil(t * count - 1) / count;
  };
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/** Resolve an EasingInput to a concrete EasingFn */
export function resolveEasing(input: EasingInput): EasingFn {
  if (typeof input === "function") return input;
  if (Array.isArray(input)) return cubicBezier(input[0], input[1], input[2], input[3]);
  return EASING_MAP[input] ?? linear;
}

// ─── Public Export ───────────────────────────────────────────────────────────

/** All easing presets accessible as an object */
export const Easing = EASING_MAP;
