// ---------------------------------------------------------------------------
// Black-76 (options on futures) pricing + implied vol + seller-relevant
// derivations: expected move, probability of touch, strike cushion.
// All vols are fractions (0.30 = 30%), time in years.
// ---------------------------------------------------------------------------

import { normCdf } from "./stats";

const SQRT_2PI = Math.sqrt(2 * Math.PI);

function pdf(x: number): number {
  return Math.exp(-(x * x) / 2) / SQRT_2PI;
}

/** Black-76 price of a European option on a future F, strike K. */
export function black76Price(
  F: number,
  K: number,
  t: number,
  vol: number,
  type: "CE" | "PE",
  r = 0,
): number {
  if (t <= 0 || vol <= 0 || F <= 0 || K <= 0) {
    // Intrinsic value at/after expiry.
    const intrinsic = type === "CE" ? Math.max(F - K, 0) : Math.max(K - F, 0);
    return intrinsic * Math.exp(-r * Math.max(t, 0));
  }
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(F / K) + (vol * vol) / 2 * t) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  const disc = Math.exp(-r * t);
  if (type === "CE") return disc * (F * normCdf(d1) - K * normCdf(d2));
  return disc * (K * normCdf(-d2) - F * normCdf(-d1));
}

/** Black-76 vega (per 1.00 = 100 vol points) — used by the IV solver. */
export function black76Vega(F: number, K: number, t: number, vol: number, r = 0): number {
  if (t <= 0 || vol <= 0 || F <= 0 || K <= 0) return 0;
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(F / K) + (vol * vol) / 2 * t) / (vol * sqrtT);
  return F * Math.exp(-r * t) * pdf(d1) * sqrtT;
}

/**
 * Implied vol via Newton's method with a bisection fallback. Returns null when
 * the price is below intrinsic or the solver cannot converge — never a guess.
 */
export function impliedVol(
  price: number,
  F: number,
  K: number,
  t: number,
  type: "CE" | "PE",
  r = 0,
): number | null {
  if (!(price > 0) || t <= 0 || F <= 0 || K <= 0) return null;
  const intrinsic = type === "CE" ? Math.max(F - K, 0) : Math.max(K - F, 0);
  if (price < intrinsic * Math.exp(-r * t) - 1e-6) return null;

  let vol = 0.4; // sensible seed for a metal
  for (let i = 0; i < 50; i++) {
    const model = black76Price(F, K, t, vol, type, r);
    const diff = model - price;
    if (Math.abs(diff) < 1e-4) return vol;
    const vega = black76Vega(F, K, t, vol, r);
    if (vega < 1e-8) break;
    vol -= diff / vega;
    if (vol <= 0.001 || vol > 5) break;
  }

  // Bisection fallback over a wide bracket.
  let lo = 0.001;
  let hi = 5;
  let flo = black76Price(F, K, t, lo, type, r) - price;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const fmid = black76Price(F, K, t, mid, type, r) - price;
    if (Math.abs(fmid) < 1e-4) return mid;
    if (Math.sign(fmid) === Math.sign(flo)) {
      lo = mid;
      flo = fmid;
    } else {
      hi = mid;
    }
  }
  return null;
}

/** ±1σ expected move (price units) over tenor `t` years at vol `vol`. */
export function expectedMove(F: number, vol: number, t: number): number {
  if (F <= 0 || vol <= 0 || t <= 0) return 0;
  return F * vol * Math.sqrt(t);
}

/**
 * Probability that a GBM future touches `barrier` before expiry (reflection
 * principle, drift≈0). For an option seller this is the "will my strike get
 * tested?" number — strictly higher than probability of finishing ITM.
 */
export function probabilityOfTouch(
  F: number,
  barrier: number,
  vol: number,
  t: number,
): number {
  if (F <= 0 || barrier <= 0 || vol <= 0 || t <= 0) return 0;
  if (F === barrier) return 1;
  const sigmaSqrtT = vol * Math.sqrt(t);
  // Distance to barrier in sigma units; touch prob ≈ 2·N(-|d|).
  const d = Math.abs(Math.log(barrier / F)) / sigmaSqrtT;
  return Math.min(1, 2 * normCdf(-d));
}

/** Cushion of a strike from spot, expressed in σ (expected-move units). */
export function cushionSigma(F: number, strike: number, vol: number, t: number): number {
  const em = expectedMove(F, vol, t);
  if (em <= 0) return 0;
  return Math.abs(strike - F) / em;
}
