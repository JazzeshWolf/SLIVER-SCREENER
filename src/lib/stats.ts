// ---------------------------------------------------------------------------
// Small, dependency-free numerical helpers used by the scoring engine.
// Everything here is pure and unit-tested.
// ---------------------------------------------------------------------------

import type { Point } from "./types";

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** Clamp x to [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Winsorize (clip) a z-score to ±cap so a single spike can't dominate. */
export function winsorize(z: number, cap = 2.5): number {
  if (!Number.isFinite(z)) return 0;
  return clamp(z, -cap, cap);
}

/**
 * z-score of `value` against a sample. Returns null when the sample is too
 * small or has no dispersion (so the caller can drop the factor rather than
 * fabricate a confident 0).
 */
export function zScore(value: number, sample: number[]): number | null {
  if (sample.length < 2) return null;
  const m = mean(sample);
  const s = std(sample);
  if (!Number.isFinite(s) || s === 0) return null;
  return (value - m) / s;
}

/** Map a winsorized z (±cap) into the [-1, +1] signal space, linearly. */
export function zToSignal(z: number, cap = 2.5): number {
  return clamp(winsorize(z, cap) / cap, -1, 1);
}

/** Pearson correlation of two equal-length series. Null if insufficient data. */
export function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ax = a.slice(a.length - n);
  const bx = b.slice(b.length - n);
  const ma = mean(ax);
  const mb = mean(bx);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = ax[i] - ma;
    const xb = bx[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

/** Daily log returns from a price series. */
export function logReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0 && values[i] > 0) {
      out.push(Math.log(values[i] / values[i - 1]));
    }
  }
  return out;
}

/** Annualized realized volatility (fraction) from a price series. */
export function realizedVol(values: number[], periodsPerYear = 252): number | null {
  const r = logReturns(values);
  const s = std(r);
  if (!Number.isFinite(s)) return null;
  return s * Math.sqrt(periodsPerYear);
}

/**
 * Percentile rank (0..100) of `value` within a sample: the share of sample
 * values it is greater-than-or-equal to. Used for IV Rank / IV percentile.
 */
export function percentRank(value: number, sample: number[]): number | null {
  if (sample.length === 0) return null;
  const below = sample.filter((x) => x <= value).length;
  return (below / sample.length) * 100;
}

/**
 * IV "Rank" in the classic sense: where current sits between the min and max
 * of the sample (0 = at the low, 100 = at the high). Distinct from percentile.
 */
export function rangeRank(value: number, sample: number[]): number | null {
  if (sample.length === 0) return null;
  const lo = Math.min(...sample);
  const hi = Math.max(...sample);
  if (hi === lo) return 50;
  return clamp(((value - lo) / (hi - lo)) * 100, 0, 100);
}

/** Last n numeric values of a Point[] series (oldest->newest input assumed). */
export function tail(points: Point[], n: number): number[] {
  return points.slice(Math.max(0, points.length - n)).map((p) => p.v);
}

/** Percent change of the most recent value vs the value `lookback` steps back. */
export function changeOverWindow(points: Point[], lookback: number): number | null {
  if (points.length < lookback + 1) return null;
  const latest = points[points.length - 1].v;
  const past = points[points.length - 1 - lookback].v;
  if (!Number.isFinite(past) || past === 0) return null;
  return (latest - past) / past;
}

/** Most recent value vs its simple moving average over `window`, as a fraction. */
export function vsMovingAverage(points: Point[], window: number): number | null {
  if (points.length < window) return null;
  const slice = tail(points, window);
  const m = mean(slice);
  const latest = slice[slice.length - 1];
  if (!Number.isFinite(m) || m === 0) return null;
  return (latest - m) / m;
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 approximation). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export function normPdf(x: number): number {
  return 0.3989422804014327 * Math.exp(-(x * x) / 2);
}
