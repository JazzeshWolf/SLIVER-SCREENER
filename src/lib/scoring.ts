// ---------------------------------------------------------------------------
// Directional sentiment engine (multi-horizon) + regime mapper + premium-sell
// score. Pure functions, unit-tested. See blueprint §2A.
//
// Honesty: the weights below are hand-set PRIORS, not backtested/optimized.
// The score is a structured opinion and a decision aid — the trustworthy
// signal is the REGIME (trend vs chop) and horizon DIVERGENCE, not the decimal.
// ---------------------------------------------------------------------------

import type {
  FactorContribution,
  Horizon,
  HorizonScore,
  LiveInputs,
  McxData,
  PremiumSellScore,
  Regime,
  RegimeResult,
} from "./types";
import {
  changeOverWindow,
  clamp,
  vsMovingAverage,
  zToSignal,
  zScore,
} from "./stats";

// --- Per-horizon configuration ---------------------------------------------
// `window` is the lookback the normalization uses; `weight` is the prior.
// Structural/slow factors dominate 1M and fade to 0 at 1D.

interface FactorConfig {
  key: string;
  label: string;
  windows: Record<Horizon, number>;
  weights: Record<Horizon, number>;
}

export const FACTOR_CONFIG: FactorConfig[] = [
  {
    key: "dxy",
    label: "Dollar (DXY, inverse)",
    windows: { "1D": 3, "1W": 10, "1M": 30 },
    weights: { "1D": 0.24, "1W": 0.18, "1M": 0.14 },
  },
  {
    key: "real10y",
    label: "Real yield (inverse)",
    windows: { "1D": 3, "1W": 10, "1M": 30 },
    weights: { "1D": 0.18, "1W": 0.15, "1M": 0.13 },
  },
  {
    key: "silverMomo",
    label: "Silver momentum",
    windows: { "1D": 5, "1W": 20, "1M": 50 },
    weights: { "1D": 0.22, "1W": 0.16, "1M": 0.12 },
  },
  {
    key: "goldMomo",
    label: "Gold momentum",
    windows: { "1D": 5, "1W": 20, "1M": 50 },
    weights: { "1D": 0.16, "1W": 0.13, "1M": 0.11 },
  },
  {
    key: "mcxPositioning",
    label: "MCX OI / price",
    windows: { "1D": 1, "1W": 5, "1M": 20 },
    weights: { "1D": 0.12, "1W": 0.12, "1M": 0.12 },
  },
  {
    key: "usdInr",
    label: "USD-INR (MCX)",
    windows: { "1D": 3, "1W": 10, "1M": 30 },
    weights: { "1D": 0.08, "1W": 0.1, "1M": 0.1 },
  },
  {
    key: "gsr",
    label: "Gold-silver ratio (revert)",
    windows: { "1D": 20, "1W": 60, "1M": 252 },
    weights: { "1D": 0.0, "1W": 0.06, "1M": 0.08 },
  },
  {
    key: "deficitBias",
    label: "Structural deficit bias",
    windows: { "1D": 0, "1W": 0, "1M": 0 },
    weights: { "1D": 0.0, "1W": 0.1, "1M": 0.2 },
  },
];

// Standing structural bias: silver runs a multi-year supply deficit. Slow,
// constant, deliberately modest. Only applied on 1W/1M (weight 0 on 1D).
const DEFICIT_BIAS_SIGNAL = 0.6;

const BULLISH_THRESHOLD = 3;
const MIN_OBS_FOR_FULL_CONFIDENCE = 30;

/** Raw per-factor signal in [-1, +1], or null when inputs are missing. */
function factorSignal(
  key: string,
  window: number,
  live: LiveInputs,
  mcx: McxData,
): number | null {
  switch (key) {
    case "dxy": {
      const ch = changeOverWindow(live.dxyHistory, window);
      const z = ch === null ? null : zScore(ch, windowChanges(live.dxyHistory, window));
      return z === null ? null : -zToSignal(z); // inverse: dollar down = bullish
    }
    case "real10y": {
      const ch = changeOverWindow(live.real10yHistory, window);
      const z = ch === null ? null : zScore(ch, windowChanges(live.real10yHistory, window));
      return z === null ? null : -zToSignal(z); // inverse: yields down = bullish
    }
    case "silverMomo": {
      const v = vsMovingAverage(live.xagHistory, window);
      return v === null ? null : clamp(v * 12, -1, 1); // ~8% above MA -> ~+1
    }
    case "goldMomo": {
      const v = vsMovingAverage(live.xauHistory, window);
      return v === null ? null : clamp(v * 12, -1, 1);
    }
    case "mcxPositioning": {
      const oiChg = mcx.mcx.oiChg;
      const fut = mcx.mcx.silverFut;
      const prev = mcx.mcx.prevClose;
      if (oiChg === null || fut === null || prev === null || prev === 0) return null;
      const priceDir = Math.sign(fut - prev);
      const oiDir = Math.sign(oiChg);
      // rising OI + rising price = fresh longs (bullish); rising OI + falling = fresh shorts.
      const mag = clamp(Math.abs((fut - prev) / prev) * 25, 0, 1);
      return clamp(priceDir * (oiDir >= 0 ? 1 : 0.5) * mag + (oiDir < 0 ? priceDir * 0.3 : 0), -1, 1);
    }
    case "usdInr": {
      const ch = changeOverWindow(live.usdInrHistory, window);
      const z = ch === null ? null : zScore(ch, windowChanges(live.usdInrHistory, window));
      return z === null ? null : zToSignal(z); // INR weakening (USDINR up) = bullish MCX ₹
    }
    case "gsr": {
      // Contrarian: GSR high vs its mean => silver cheap vs gold => mild bullish.
      if (live.xagHistory.length < window || live.xauHistory.length < window) return null;
      const ratios: number[] = [];
      const n = Math.min(live.xagHistory.length, live.xauHistory.length);
      for (let i = n - window; i < n; i++) {
        const ag = live.xagHistory[i]?.v;
        const au = live.xauHistory[i]?.v;
        if (ag && au && ag > 0) ratios.push(au / ag);
      }
      if (ratios.length < 5) return null;
      const current = ratios[ratios.length - 1];
      const z = zScore(current, ratios);
      return z === null ? null : zToSignal(z);
    }
    case "deficitBias":
      return DEFICIT_BIAS_SIGNAL;
    default:
      return null;
  }
}

/** Series of rolling `window`-step percent changes, for z-scoring the latest change. */
function windowChanges(points: { v: number }[], window: number): number[] {
  const out: number[] = [];
  for (let i = window; i < points.length; i++) {
    const past = points[i - window].v;
    if (past !== 0 && Number.isFinite(past)) out.push((points[i].v - past) / past);
  }
  return out;
}

/**
 * Confidence in [0,1] for a horizon: shrinks the score toward 0 when data is
 * stale, sparse, or when too many factors are missing. Never lets a confident-
 * looking number ride on one input.
 */
function horizonConfidence(
  presentFactors: number,
  totalWeightPresent: number,
  maxHistory: number,
  stale: boolean,
): number {
  // Calibrated so a solid core (e.g. gold momentum + USD-INR + structural bias)
  // reads as usable confidence, while still shrinking on stale/sparse data.
  const coverage = clamp(totalWeightPresent / 0.6, 0.4, 1); // weight backed by data
  const historyFactor = clamp(maxHistory / MIN_OBS_FOR_FULL_CONFIDENCE, 0.4, 1);
  const breadth = clamp(presentFactors / 3, 0.5, 1); // ~3 live factors = full breadth
  const staleFactor = stale ? 0.7 : 1;
  return clamp(coverage * historyFactor * breadth * staleFactor, 0, 1);
}

export function scoreHorizon(
  horizon: Horizon,
  live: LiveInputs,
  mcx: McxData,
): HorizonScore {
  const contributions: FactorContribution[] = [];
  let presentWeight = 0;

  for (const cfg of FACTOR_CONFIG) {
    const weight = cfg.weights[horizon];
    if (weight <= 0) continue;
    const s = factorSignal(cfg.key, cfg.windows[horizon], live, mcx);
    const present = s !== null;
    if (present) presentWeight += weight;
    contributions.push({
      key: cfg.key,
      label: cfg.label,
      raw: s,
      s: s ?? 0,
      weight, // nominal; effective weight computed after redistribution below
      present,
    });
  }

  // Redistribute weight pro-rata across PRESENT factors so missing data is not
  // silently treated as a 0 signal.
  const present = contributions.filter((c) => c.present);
  let rawScore = 0;
  if (presentWeight > 0) {
    for (const c of present) {
      const eff = c.weight / presentWeight;
      c.weight = eff;
      rawScore += eff * c.s;
    }
  }
  for (const c of contributions) if (!c.present) c.weight = 0;

  rawScore = clamp(rawScore * 10, -10, 10);

  const maxHistory = Math.max(
    live.xagHistory.length,
    live.dxyHistory.length,
    live.real10yHistory.length,
  );
  const stale = live.partial || mcx.stale;
  const confidence = present.length
    ? horizonConfidence(present.length, presentWeight, maxHistory, stale)
    : 0;

  const score = clamp(rawScore * confidence, -10, 10);
  const bucket =
    score >= BULLISH_THRESHOLD ? "bullish" : score <= -BULLISH_THRESHOLD ? "bearish" : "neutral";

  return {
    horizon,
    score: round1(score),
    rawScore: round1(rawScore),
    confidence: round2(confidence),
    bucket,
    factors: contributions,
    partial: present.length < contributions.length,
  };
}

export function scoreAllHorizons(live: LiveInputs, mcx: McxData): Record<Horizon, HorizonScore> {
  return {
    "1D": scoreHorizon("1D", live, mcx),
    "1W": scoreHorizon("1W", live, mcx),
    "1M": scoreHorizon("1M", live, mcx),
  };
}

// --- Regime mapping ---------------------------------------------------------

const REGIME_LABELS: Record<Regime, { label: string; structure: string }> = {
  trend_up: { label: "Trend up", structure: "Sell puts / put-credit spreads" },
  trend_down: { label: "Trend down", structure: "Sell calls / call-credit spreads" },
  chop: { label: "Chop / range", structure: "Sell strangle (both sides)" },
  no_conviction: { label: "No conviction", structure: "Smaller size, wider strikes, or sit out" },
};

/**
 * Map the three horizon scores to a regime + recommended structure. The DTE-
 * matched horizon (1W for weeklies, 1M for monthlies) must clear the bullish/
 * bearish threshold before any directional lean is offered; otherwise default
 * to the neutral range play. `prevRegime` enables hysteresis (caller passes the
 * last shown regime to avoid flicker — only flip when the new read is clear).
 */
export function deriveRegime(
  scores: Record<Horizon, HorizonScore>,
  dte: number | null,
  prevRegime?: Regime,
): RegimeResult {
  const dteHorizon: Horizon = dte !== null && dte <= 10 ? "1W" : "1M";
  const decision = scores[dteHorizon];
  const s1w = scores["1W"].score;
  const s1m = scores["1M"].score;

  const signs = [Math.sign(s1w), Math.sign(s1m)];
  const allUp = signs.every((x) => x > 0) && Math.min(s1w, s1m) >= BULLISH_THRESHOLD;
  const allDown = signs.every((x) => x < 0) && Math.max(s1w, s1m) <= -BULLISH_THRESHOLD;
  const disagree = signs[0] !== signs[1] && signs[0] !== 0 && signs[1] !== 0;
  const bothWeak = Math.abs(s1w) < BULLISH_THRESHOLD && Math.abs(s1m) < BULLISH_THRESHOLD;

  let regime: Regime;
  if (allUp) regime = "trend_up";
  else if (allDown) regime = "trend_down";
  else if (disagree) regime = "chop";
  else if (bothWeak) regime = "no_conviction";
  else regime = "chop";

  // Hysteresis: only flip away from a directional trend if the decision horizon
  // is no longer clearly in that direction (prevents single-update flicker).
  if (prevRegime === "trend_up" && decision.score > BULLISH_THRESHOLD - 1) regime = "trend_up";
  if (prevRegime === "trend_down" && decision.score < -(BULLISH_THRESHOLD - 1)) regime = "trend_down";

  const directionalLeanAllowed =
    (regime === "trend_up" || regime === "trend_down") &&
    Math.abs(decision.score) >= BULLISH_THRESHOLD;

  return {
    regime,
    label: REGIME_LABELS[regime].label,
    structure: REGIME_LABELS[regime].structure,
    dteHorizon,
    directionalLeanAllowed,
  };
}

// --- Premium-Sell score (0..100) -------------------------------------------

/** Theta sweet-spot curve: peaks ~20-40 DTE, ~0 inside 7 DTE (gamma risk). */
export function thetaZone(dte: number | null): number | null {
  if (dte === null || dte < 0) return null;
  if (dte < 7) return clamp(dte / 7, 0, 1) * 0.3; // gamma danger -> low
  if (dte <= 45) {
    // bell centered at ~30
    const x = (dte - 30) / 18;
    return clamp(Math.exp(-x * x), 0, 1);
  }
  return clamp(1 - (dte - 45) / 90, 0.2, 0.8); // far-dated: decent but slow theta
}

/** IV/RV ratio mapped to 0..1 (1.0 ratio -> ~0.5, >1.2 rich -> high). */
function ivRvComponent(iv: number | null, rv: number | null): number | null {
  if (iv === null || rv === null || rv <= 0) return null;
  const ratio = iv / rv;
  return clamp((ratio - 0.8) / 0.6, 0, 1); // 0.8 -> 0, 1.4 -> 1
}

export function premiumSellScore(mcx: McxData, events: { date: string }[], today: Date): PremiumSellScore {
  const ivRank = mcx.options.ivRank; // 0..100
  const ivRv = ivRvComponent(mcx.options.atmIv, mcx.options.rv20);
  const theta = thetaZone(mcx.mcx.dte);

  // Event clear: 1 if no flagged event within 3 sessions, else 0.
  const horizonMs = 3 * 24 * 3600 * 1000;
  const soonEvent = events.some((e) => {
    const dt = new Date(e.date).getTime() - today.getTime();
    return dt >= 0 && dt <= horizonMs;
  });
  const eventClear = events.length === 0 ? null : soonEvent ? 0 : 1;

  // Weighted blend over AVAILABLE components (renormalize like the directional engine).
  const parts: { w: number; v: number }[] = [];
  if (ivRank !== null) parts.push({ w: 0.4, v: ivRank / 100 });
  if (ivRv !== null) parts.push({ w: 0.25, v: ivRv });
  if (theta !== null) parts.push({ w: 0.2, v: theta });
  if (eventClear !== null) parts.push({ w: 0.15, v: eventClear });

  const wsum = parts.reduce((a, p) => a + p.w, 0);
  const score = wsum > 0 ? (parts.reduce((a, p) => a + p.w * p.v, 0) / wsum) * 100 : 0;
  const confidence = clamp(wsum, 0, 1); // share of model backed by real data

  const band = score >= 65 ? "green" : score >= 40 ? "amber" : "red";
  const note =
    band === "green"
      ? "Premium rich, theta favorable, event window clear — seller's market."
      : band === "amber"
        ? "Mixed: sellable but check IV rank and event calendar."
        : "Low IV or event risk — premium selling unattractive here.";

  return {
    score: Math.round(score),
    band,
    components: { ivRank, ivRvRatio: ivRv, thetaZone: theta, eventClear },
    confidence: round2(confidence),
    note,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
