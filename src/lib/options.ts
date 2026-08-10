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
 * Black-76 delta: N(d1) for a call, N(d1)−1 for a put. Sign convention is the
 * LONG option's delta; a seller carries the negative of it.
 */
export function black76Delta(
  F: number,
  K: number,
  t: number,
  vol: number,
  type: "CE" | "PE",
  r = 0,
): number {
  if (t <= 0 || vol <= 0 || F <= 0 || K <= 0) {
    const itm = type === "CE" ? F > K : F < K;
    return itm ? (type === "CE" ? 1 : -1) : 0;
  }
  const d1 = (Math.log(F / K) + (vol * vol) / 2 * t) / (vol * Math.sqrt(t));
  const disc = Math.exp(-r * t);
  return type === "CE" ? disc * normCdf(d1) : disc * (normCdf(d1) - 1);
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

/**
 * Probability the future FINISHES above `level` at expiry (risk-neutral GBM,
 * drift≈0). For a sold call this is the chance of finishing ITM.
 */
export function probabilityAbove(F: number, level: number, vol: number, t: number): number {
  if (F <= 0 || level <= 0 || vol <= 0 || t <= 0) return F > level ? 1 : 0;
  const d2 = (Math.log(F / level) - (vol * vol) / 2 * t) / (vol * Math.sqrt(t));
  return normCdf(d2);
}

/** Probability the future finishes below `level` at expiry. */
export function probabilityBelow(F: number, level: number, vol: number, t: number): number {
  return 1 - probabilityAbove(F, level, vol, t);
}

// ---------------------------------------------------------------------------
// Forecast measure
//
// Everything above is risk-neutral: it prices off the market's own IV with zero
// drift. A seller deciding WHICH strike to sell needs the opposite view — their
// own vol estimate and their own directional lean — because the gap between the
// two is the entire edge. These functions work under an explicit measure
//   ln S_T ~ N(m, sd²)
// so the caller states its assumptions instead of hiding them in a default.
// ---------------------------------------------------------------------------

/** A lognormal terminal-price measure: ln S_T ~ N(m, sd²). */
export interface Measure {
  m: number; // mean of ln S_T
  sd: number; // std dev of ln S_T
}

/**
 * Build the measure for a future F over tenor t at `vol`, with an annualized
 * `drift`. drift = 0 reproduces the risk-neutral (martingale) case.
 */
export function lognormalMeasure(F: number, vol: number, t: number, drift = 0): Measure | null {
  if (!(F > 0) || !(vol > 0) || !(t > 0)) return null;
  return { m: Math.log(F) + (drift - (vol * vol) / 2) * t, sd: vol * Math.sqrt(t) };
}

/** E[S_T] under the measure — the forward the measure implies. */
export function measureMean(ms: Measure): number {
  return Math.exp(ms.m + (ms.sd * ms.sd) / 2);
}

/** Probability a short option at `K` expires worthless (out of the money). */
export function probOtm(K: number, type: "CE" | "PE", ms: Measure): number {
  if (!(K > 0) || !(ms.sd > 0)) return 0;
  const z = (Math.log(K) - ms.m) / ms.sd;
  return type === "CE" ? normCdf(z) : 1 - normCdf(z);
}

/**
 * Expected payoff of the option at expiry under the measure — i.e. what the
 * option is "worth" on our forecast, undiscounted. Premium above this is edge.
 */
export function fairValueUnder(K: number, type: "CE" | "PE", ms: Measure): number {
  if (!(K > 0) || !(ms.sd > 0)) return 0;
  const mean = measureMean(ms);
  const d1 = (ms.m - Math.log(K)) / ms.sd + ms.sd;
  const d2 = d1 - ms.sd;
  return type === "CE"
    ? mean * normCdf(d1) - K * normCdf(d2)
    : K * normCdf(-d2) - mean * normCdf(-d1);
}

/**
 * Conditional expected loss of the SHORT option in the worst `alpha` tail
 * (CVaR / expected shortfall), in price units per kg. Positive = a loss.
 *
 * This is the number that separates "safe-looking" strikes: two strikes with
 * the same P(OTM) can have very different losses in the tail that breaches
 * them, and short options are exactly the position where that matters.
 * Closed-form under the lognormal measure — no simulation.
 */
export function cvarShort(
  K: number,
  type: "CE" | "PE",
  premium: number,
  ms: Measure,
  alpha = 0.05,
): number {
  if (!(K > 0) || !(ms.sd > 0) || !(alpha > 0) || alpha >= 1) return 0;
  const mean = measureMean(ms);
  // Barrier at the alpha-tail quantile: upper tail for a short call, lower for a put.
  const z = normInv(type === "CE" ? 1 - alpha : alpha);
  const bound = Math.exp(ms.m + ms.sd * z);

  let tailPayoff: number; // E[payoff · 1{tail}] — the partial expectation
  if (type === "CE") {
    if (bound >= K) {
      // The whole tail is in the money: E[(S−K)⁺·1{S>bound}] = E[S·1{S>bound}] − K·alpha.
      tailPayoff = mean * normCdf(ms.sd - z) - K * alpha;
    } else {
      // The tail starts below the strike, so the ITM region is the binding one.
      tailPayoff = fairValueUnder(K, "CE", ms);
    }
  } else {
    if (bound <= K) {
      // E[(K−S)⁺·1{S<bound}] = K·alpha − E[S·1{S<bound}], with z = N⁻¹(alpha) < 0.
      tailPayoff = K * alpha - mean * normCdf(z - ms.sd);
    } else {
      tailPayoff = fairValueUnder(K, "PE", ms);
    }
  }
  return Math.max(tailPayoff / alpha - premium, 0);
}

/**
 * SPAN-like margin estimate for ONE short option, in ₹/kg.
 *
 * NOT the exchange's number — MCX SPAN is not available from any free feed.
 * This revalues the short leg with Black-76 across a scan grid (price shocked
 * ±`priceScan`, vol shocked ±`volScan`), takes the worst loss, floors it with a
 * short-option minimum, and adds the premium the exchange blocks. It captures
 * the property that actually matters for ranking — far-OTM strikes genuinely
 * tie up less capital than near ones — and must always be labelled an estimate.
 */
export function spanScanMargin(
  F: number,
  K: number,
  t: number,
  vol: number,
  type: "CE" | "PE",
  opts: { priceScan?: number; volScan?: number; shortOptionMin?: number } = {},
): number {
  const priceScan = opts.priceScan ?? 0.06; // ±6% futures move
  const volScan = opts.volScan ?? 0.25; // ±25% relative vol move
  const som = opts.shortOptionMin ?? 0.005; // floor: 0.5% of the futures price
  if (!(F > 0) || !(K > 0) || !(vol > 0) || !(t > 0)) return 0;

  const base = black76Price(F, K, t, vol, type);
  let worst = 0;
  for (const fs of [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1]) {
    for (const vs of [-1, 1]) {
      const shocked = black76Price(F * (1 + fs * priceScan), K, t, vol * (1 + vs * volScan), type);
      worst = Math.max(worst, shocked - base);
    }
  }
  return Math.max(worst, som * F) + base;
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation, |ε| < 1.2e-9).
 * Needed for the CVaR tail barrier.
 */
export function normInv(p: number): number {
  if (!(p > 0) || !(p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
