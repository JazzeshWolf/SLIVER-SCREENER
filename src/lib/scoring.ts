// ---------------------------------------------------------------------------
// Directional sentiment engine (multi-horizon) + regime mapper + premium-sell
// score. Pure functions, unit-tested. See blueprint §2A.
//
// Honesty: the weights below are hand-set PRIORS, not backtested/optimized.
// The score is a structured opinion and a decision aid — the trustworthy
// signal is the REGIME (trend vs chop) and horizon DIVERGENCE, not the decimal.
// ---------------------------------------------------------------------------

import type {
  EventGate,
  FactorContribution,
  Horizon,
  HorizonScore,
  LiveInputs,
  MarketEvent,
  McxData,
  Pillar,
  PremiumSellScore,
  Regime,
  RegimeResult,
  VrpBand,
  VrpGate,
} from "./types";
import {
  changeOverWindow,
  clamp,
  vsMovingAverage,
  vsMovingAverageSeries,
  zToSignal,
  zScore,
} from "./stats";
import { metalFor } from "./metals.mjs";
import type { MetalConfig } from "./metals.mjs";
import { metalForSymbol } from "./instrument";

/**
 * z-score of the CURRENT numerator/denominator ratio against its own recent
 * distribution. Shared by every cross-metal ratio factor so they can never
 * drift apart in construction — only in which series goes on top.
 */
function ratioZ(
  numerator: { v: number }[],
  denominator: { v: number }[],
  window: number,
): number | null {
  if (numerator.length < window || denominator.length < window) return null;
  const n = Math.min(numerator.length, denominator.length);
  const ratios: number[] = [];
  for (let i = n - window; i < n; i++) {
    const a = numerator[i]?.v;
    const b = denominator[i]?.v;
    if (a && b && b > 0) ratios.push(a / b);
  }
  if (ratios.length < 5) return null;
  return zScore(ratios[ratios.length - 1], ratios);
}

// --- Per-horizon configuration ---------------------------------------------
// `window` is the lookback the normalization uses; `weight` is the prior.
// Structural/slow factors dominate 1M and fade to 0 at 1D.

interface FactorConfig {
  key: string;
  label: string;
  /**
   * Which of the four evidence pillars this factor belongs to. Display only —
   * the maths is unchanged. It exists so the factor breakdown speaks the same
   * language as the bullion verdict playbook (Global / Derivatives /
   * Technicals / INR & domestic) instead of a flat list of nine.
   */
  pillar: Pillar;
  windows: Record<Horizon, number>;
  weights: Record<Horizon, number>;
}

/**
 * Every factor the engine knows, with its label, pillar and normalization
 * window. WEIGHTS are NOT here — they live per metal in the registry, because
 * the three metals genuinely weigh these differently: real yields dominate
 * gold, barely register for copper, and sit mid-table for silver.
 */
const FACTOR_DEFS: Omit<FactorConfig, "weights">[] = [
  {
    key: "dxy",
    pillar: "global",
    label: "Dollar (USD index, inverse)",
    windows: { "1D": 3, "1W": 10, "1M": 30 },
  },
  {
    key: "real10y",
    pillar: "global",
    label: "Real yield (inverse)",
    windows: { "1D": 3, "1W": 10, "1M": 30 },
  },
  {
    key: "metalMomo",
    pillar: "tech",
    label: "Price momentum",
    windows: { "1D": 5, "1W": 20, "1M": 50 },
  },
  {
    key: "goldMomo",
    pillar: "global",
    label: "Gold leadership",
    windows: { "1D": 5, "1W": 20, "1M": 50 },
  },
  {
    // Classic long-trend regime filter: price vs its ~200-day average. Slow by
    // design — only meaningful on 1W/1M, and only once enough history accrues.
    key: "longTrend",
    pillar: "tech",
    label: "Long trend (200-DMA)",
    windows: { "1D": 0, "1W": 200, "1M": 200 },
  },
  {
    key: "mcxPositioning",
    pillar: "deriv",
    label: "MCX OI / price",
    windows: { "1D": 1, "1W": 5, "1M": 20 },
  },
  {
    key: "usdInr",
    pillar: "local",
    label: "USD-INR (MCX)",
    windows: { "1D": 3, "1W": 10, "1M": 30 },
  },
  {
    // Silver's read: a stretched ratio means silver is cheap vs gold →
    // contrarian-bullish for silver.
    key: "gsr",
    pillar: "global",
    label: "Gold-silver ratio (revert)",
    windows: { "1D": 20, "1W": 60, "1M": 252 },
  },
  {
    // The SAME ratio seen from gold's side, so the sign flips: a high ratio
    // means gold is expensive relative to silver — a mild headwind, not a
    // tailwind. Sharing one key across both metals would silently invert one.
    key: "gsrGold",
    pillar: "global",
    label: "Gold-silver ratio (gold rich)",
    windows: { "1D": 20, "1W": 60, "1M": 252 },
  },
  {
    // Copper's growth proxy. Rising copper/gold = reflation, risk-on, bullish
    // copper; falling = growth scare. Replaces gold leadership, which tells you
    // nothing about an industrial metal.
    key: "copperGold",
    pillar: "global",
    label: "Copper/gold ratio (growth)",
    windows: { "1D": 20, "1W": 60, "1M": 252 },
  },
  {
    key: "structuralBias",
    pillar: "global",
    label: "Structural bias",
    windows: { "1D": 0, "1W": 0, "1M": 0 },
  },
];

/**
 * The factor table for one metal: every factor the registry gives a weight,
 * with that metal's label for the structural prior. Cached because the direction
 * engine calls it per horizon on every render.
 */
const configCache = new Map<string, FactorConfig[]>();

export function factorConfigFor(metalId: string): FactorConfig[] {
  const metal = metalFor(metalId);
  const cached = configCache.get(metal.id);
  if (cached) return cached;
  const weights = metal.engine.weights;
  const out = FACTOR_DEFS.filter((d) => weights[d.key]).map((d) => ({
    ...d,
    label: d.key === "structuralBias" ? metal.engine.structuralLabel : d.label,
    weights: weights[d.key] as Record<Horizon, number>,
  }));
  configCache.set(metal.id, out);
  return out;
}


const BULLISH_THRESHOLD = 3;
const MIN_OBS_FOR_FULL_CONFIDENCE = 30;

/** Raw per-factor signal in [-1, +1], or null when inputs are missing. */
function factorSignal(
  key: string,
  window: number,
  live: LiveInputs,
  mcx: McxData,
  metal: MetalConfig,
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
    case "metalMomo":
      return momentumSignal(live.metalHistory, window);
    case "goldMomo":
      return momentumSignal(live.xauHistory, window);
    case "longTrend": {
      // Price vs its long (~200-day) moving average — the classic trend gate.
      // Requires meaningful history; uses what exists once past 100 points.
      const n = live.metalHistory.length;
      if (n < 100) return null;
      const v = vsMovingAverage(live.metalHistory, Math.min(window, n));
      return v === null ? null : clamp(v * 8, -1, 1); // ±12.5% from the MA saturates
    }
    case "mcxPositioning": {
      const oiChg = mcx.mcx.oiChg;
      const fut = mcx.mcx.fut;
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
      const z = ratioZ(live.xauHistory, live.metalHistory, window);
      return z === null ? null : zToSignal(z);
    }
    case "gsrGold": {
      // The same ratio read from gold's side, so the sign flips: gold rich
      // relative to silver is a mild headwind for gold.
      const z = ratioZ(live.xauHistory, live.metalHistory, window);
      return z === null ? null : -zToSignal(z);
    }
    case "copperGold": {
      // Copper/gold is the market's cleanest free growth proxy: rising means
      // reflation (bullish the industrial metal), falling means a growth scare.
      const z = ratioZ(live.metalHistory, live.xauHistory, window);
      return z === null ? null : zToSignal(z);
    }
    case "structuralBias":
      return metal.engine.structuralBias;
    default:
      return null;
  }
}

/**
 * Vol-adaptive momentum: z-score today's distance-from-MA against the asset's
 * OWN history of that distance, so a 3% move in a quiet market registers more
 * than in a wild one (standard time-series-momentum normalization). Falls back
 * to the fixed scaler when the distribution is degenerate (e.g. flat series).
 */
function momentumSignal(points: { t: string; v: number }[], window: number): number | null {
  const v = vsMovingAverage(points, window);
  if (v === null) return null;
  const series = vsMovingAverageSeries(points, window);
  const z = series.length >= 10 ? zScore(v, series) : null;
  return z !== null ? zToSignal(z) : clamp(v * 12, -1, 1);
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
  macroCoverage: number,
): number {
  // Calibrated so a solid core (e.g. gold momentum + USD-INR + structural bias)
  // reads as usable confidence, while still shrinking on stale/sparse data.
  const coverage = clamp(totalWeightPresent / 0.6, 0.4, 1); // weight backed by data
  const historyFactor = clamp(maxHistory / MIN_OBS_FOR_FULL_CONFIDENCE, 0.4, 1);
  const breadth = clamp(presentFactors / 3, 0.5, 1); // ~3 live factors = full breadth
  const staleFactor = stale ? 0.7 : 1;
  // The dollar (DXY) and real yields are silver's two biggest macro drivers. If
  // they're missing, the read is flying half-blind on momentum alone — cap
  // confidence accordingly rather than letting momentum + deficit bias mask it.
  const macroFactor = clamp(0.6 + 0.4 * macroCoverage, 0.6, 1);
  return clamp(coverage * historyFactor * breadth * staleFactor * macroFactor, 0, 1);
}

/**
 * Fraction of the macro-pillar weight actually backed by data — the guard that
 * stops a confident-looking score riding on momentum alone.
 *
 * WHICH factors count as the macro pillar is per metal. For bullion it is the
 * dollar and real yields. For copper, real yields are near-irrelevant (there is
 * no opportunity-cost story for a metal you buy to consume), so the pillar is
 * the dollar and the growth proxy instead.
 */
function macroPillarKeys(metal: MetalConfig): string[] {
  return metal.id === "copper" ? ["dxy", "copperGold"] : ["dxy", "real10y"];
}

function macroCoverageOf(
  metal: MetalConfig,
  horizon: Horizon,
  contributions: FactorContribution[],
): number {
  const keys = macroPillarKeys(metal);
  let nominal = 0;
  let present = 0;
  for (const cfg of factorConfigFor(metal.id)) {
    if (!keys.includes(cfg.key)) continue;
    const w = cfg.weights[horizon];
    if (w <= 0) continue;
    nominal += w;
    if (contributions.find((c) => c.key === cfg.key)?.present) present += w;
  }
  return nominal > 0 ? present / nominal : 1;
}

export function scoreHorizon(
  horizon: Horizon,
  live: LiveInputs,
  mcx: McxData,
  metalId?: string,
): HorizonScore {
  const metal = metalId ? metalFor(metalId) : metalForSymbol(mcx.mcx.symbol);
  const contributions: FactorContribution[] = [];
  let presentWeight = 0;

  for (const cfg of factorConfigFor(metal.id)) {
    const weight = cfg.weights[horizon];
    if (weight <= 0) continue;
    const s = factorSignal(cfg.key, cfg.windows[horizon], live, mcx, metal);
    const present = s !== null;
    if (present) presentWeight += weight;
    contributions.push({
      key: cfg.key,
      label: cfg.label,
      pillar: cfg.pillar,
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

  // Best available history across all inputs — confidence should reflect the
  // series actually backing the present factors (e.g. gold/INR), not only silver.
  const maxHistory = Math.max(
    live.metalHistory.length,
    live.xauHistory.length,
    live.dxyHistory.length,
    live.usdInrHistory.length,
    live.real10yHistory.length,
  );
  const stale = live.partial || mcx.stale;
  const macroCoverage = macroCoverageOf(metal, horizon, contributions);
  const confidence = present.length
    ? horizonConfidence(present.length, presentWeight, maxHistory, stale, macroCoverage)
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

export function scoreAllHorizons(
  live: LiveInputs,
  mcx: McxData,
  metalId?: string,
): Record<Horizon, HorizonScore> {
  return {
    "1D": scoreHorizon("1D", live, mcx, metalId),
    "1W": scoreHorizon("1W", live, mcx, metalId),
    "1M": scoreHorizon("1M", live, mcx, metalId),
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

// --- Gates ------------------------------------------------------------------
// Two hard gates sit ON TOP of the 0–100 blend rather than inside it. A score
// is an opinion about how attractive premium looks; a gate is a statement that
// selling is a bad idea regardless of how attractive it looks. Folding either
// into the weighted average would let a rich IV rank out-vote them.

/** Days inside which a major print counts as "no time left to react". */
export const IMMINENT_EVENT_DAYS = 3;

/** VRP band edges, in vol points (IV − RV). Per the bullion verdict playbook. */
const VRP_CLEAR = 3;
const VRP_STANDARD = 2;

/**
 * Volatility risk premium: are you being paid more than the metal actually
 * moves? VRP < 0 means no — the trade is negative-EV before any directional
 * view, so it blocks selling outright.
 *
 * The `proxy` flag matters as much as the number. When ATM IV is a realized-vol
 * proxy (no traded option price), IV is literally computed as rv20 × 1.05, so
 * VRP is mechanically ≈ +5% of RV and carries no information. Reporting that as
 * a healthy premium would be the most dangerous kind of false comfort.
 */
export function vrpGate(mcx: McxData): VrpGate {
  const iv = mcx.options.atmIv;
  const rv = mcx.options.rv20;
  const proxy = mcx.options.ivEstimated === true;

  if (iv == null || rv == null) {
    return {
      vrp: null, iv, rv, band: "marginal", blocked: false, proxy,
      note: "No IV or realized vol — VRP unknown. Size down until it resolves.",
    };
  }

  const vrp = round2((iv - rv) * 100); // vol points
  const band: VrpBand =
    vrp < 0 ? "blocked" : vrp >= VRP_CLEAR ? "clear" : vrp >= VRP_STANDARD ? "standard" : "marginal";

  if (proxy) {
    return {
      vrp, iv, rv, band: "marginal", blocked: false, proxy,
      note: "IV is a realized-vol proxy, not a traded price — this VRP is mechanical, not a real read.",
    };
  }

  const note =
    band === "blocked"
      ? `IV ${(iv * 100).toFixed(1)}% is BELOW realized ${(rv * 100).toFixed(1)}% — you are being paid less than the metal actually moves. Selling is negative-EV here.`
      : band === "clear"
        ? `IV runs ${vrp.toFixed(1)} vol points over realized — comfortably sellable.`
        : band === "standard"
          ? `IV ${vrp.toFixed(1)} points over realized — sellable at standard size.`
          : `Only ${vrp.toFixed(1)} vol points of premium over realized — thin. Half size, wider strikes, or wait.`;

  return { vrp, iv, rv, band, blocked: band === "blocked", proxy, note };
}

/** A print big enough to gap the metal through a short strike. */
function isMajor(e: MarketEvent): boolean {
  return e.weight === 3 || e.kind === "fomc" || e.kind === "us_cpi" || e.kind === "us_jobs";
}

/**
 * Event risk as a gate. Deliberately two-level rather than one absolute veto:
 * applied literally over a ~30-day monthly, an absolute veto fires almost every
 * cycle (CPI is monthly, FOMC ~6-weekly) and would pin this card permanently
 * red — which trains you to ignore it, the opposite of what a gate is for.
 *
 *  - `vetoed`   — a major print within IMMINENT_EVENT_DAYS. No time to exit
 *                 cleanly, so this hard-reds the card.
 *  - `inWindow` — every major print between now and option expiry. Not a veto,
 *                 but the reason to prefer defined risk over naked premium.
 */
export function eventGate(
  events: MarketEvent[],
  optionDte: number | null,
  today: Date,
): EventGate {
  const now = today.getTime();
  const dayMs = 24 * 3600 * 1000;
  const windowDays = optionDte ?? IMMINENT_EVENT_DAYS;

  const upcoming = events
    .filter(isMajor)
    .map((e) => ({ e, days: (new Date(e.date).getTime() - now) / dayMs }))
    .filter((x) => x.days >= 0)
    .sort((a, b) => a.days - b.days);

  const inWindow = upcoming.filter((x) => x.days <= windowDays).map((x) => x.e);
  const first = upcoming[0];
  const vetoed = first != null && first.days <= IMMINENT_EVENT_DAYS;

  const note = vetoed
    ? `${first.e.name} lands in ${Math.max(0, Math.round(first.days))}d — too close to exit cleanly. Don't open new naked premium into it.`
    : inWindow.length
      ? `${inWindow.length} major print${inWindow.length > 1 ? "s" : ""} before expiry (${inWindow.map((e) => e.name).join(", ")}) — defined risk only.`
      : "No major prints before expiry.";

  return {
    vetoed,
    imminent: vetoed ? first.e : null,
    daysAway: first ? Math.round(first.days) : null,
    inWindow,
    note,
  };
}

export function premiumSellScore(mcx: McxData, events: MarketEvent[], today: Date): PremiumSellScore {
  const ivRank = mcx.options.ivRank; // 0..100
  const ivRv = ivRvComponent(mcx.options.atmIv, mcx.options.rv20);
  // Theta is about the OPTION the seller holds — use the option DTE, not the
  // future's (MCX metal options can expire before the future).
  const theta = thetaZone(mcx.mcx.optionDte ?? mcx.mcx.dte);

  const vrp = vrpGate(mcx);
  const eventState = eventGate(events, mcx.mcx.optionDte ?? mcx.mcx.dte, today);

  // Retained as a 0/1 COMPONENT for continuity of the score's shape; the real
  // event decision is the gate above, which can override the band outright.
  const horizonMs = IMMINENT_EVENT_DAYS * 24 * 3600 * 1000;
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

  // Either gate overrides the blend. A rich IV rank must not be able to show
  // green while you are being paid less than the metal moves, or while a print
  // that routinely gaps it lands before you could get out.
  const blocked = vrp.blocked || eventState.vetoed;
  const scored = score >= 65 ? "green" : score >= 40 ? "amber" : "red";
  const band: PremiumSellScore["band"] = blocked ? "red" : scored;

  const note = vrp.blocked
    ? vrp.note
    : eventState.vetoed
      ? eventState.note
      : band === "green"
        ? "Premium rich, theta favorable, event window clear — seller's market."
        : band === "amber"
          ? "Mixed: sellable but check IV rank and event calendar."
          : "Low IV or event risk — premium selling unattractive here.";

  return {
    score: Math.round(score),
    band,
    components: { ivRank, ivRvRatio: ivRv, thetaZone: theta, eventClear },
    vrp,
    events: eventState,
    blocked,
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
