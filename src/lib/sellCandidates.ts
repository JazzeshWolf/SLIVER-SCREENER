// ---------------------------------------------------------------------------
// Sell-candidate screener: rank every OTM leg on the chain and surface the
// BALANCED strikes — the ones where premium earned and risk taken clear.
//
// Why not just sort by one column:
//   · by premium      → picks ATM, which is where short options blow up;
//   · by P(OTM)       → picks the furthest strike, which earns nothing;
//   · by "edge"       → on MCX silver IV sits well above realized vol, so EVERY
//                       strike shows positive edge and the sort degenerates into
//                       "furthest and least liquid wins";
//   · by delta alone  → ignores that two 0.05-delta strikes can carry very
//                       different tail losses and very different liquidity.
// So CONV blends six normalized sub-scores, and a strike must first survive a
// set of hard filters (stale prints on this chain are the #1 correctness risk —
// a leg that last traded days ago shows a large fake edge).
//
// Honesty: the CONV weights below are hand-set PRIORS, not backtested — the
// same convention as scoring.ts. Trust the shortlist and the columns, not the
// second decimal of the score. Margin is MODELLED (see spanScanMargin), never
// the exchange's number.
// ---------------------------------------------------------------------------

import type { McxData, OptionQuote, RegimeResult, SellCandidate, SellScreen } from "./types";
import {
  black76Delta,
  cushionSigma,
  cvarShort,
  fairValueUnder,
  lognormalMeasure,
  probOtm,
  probabilityOfTouch,
  spanScanMargin,
  type Measure,
} from "./options";
import { clamp } from "./stats";
import { lotUnitsForSymbol, metalForSymbol } from "./instrument";

// --- Tunables ---------------------------------------------------------------

/** Forecast vol = this much realized + the rest ATM IV. A seller's honest view
 *  sits below IV; the gap is the premium they are being paid to carry. */
const RV_WEIGHT = 0.6;
/** Directional drift is capped at this fraction of forecast vol (annualized),
 *  so the hand-set direction weights can never dominate the probabilities. */
const MAX_DRIFT_SIGMA = 0.5;

// Metal-independent filters. The OI floors and the ROM normalizer ARE
// metal-dependent and come from the registry (`metal.screen`) — silver's deep
// book and copper's thin one cannot share a liquidity threshold.
const FILTERS = {
  minPremiumPctF: 0.0015, // 0.15% of the futures price
  minCushionSigma: 0.6, // inside this it's a gamma trade, not a premium sale
  smileTolVolPts: 0.04, // absolute floor for the off-smile test (4 vol points)
  smileTolMad: 4, // ... or 4× the median absolute deviation of the fit
};

/** CONV sub-score weights. Hand-set priors — see the file header. */
export const CONV_WEIGHTS = {
  ret: 0.28, // return on capital
  safety: 0.22, // probability of keeping the premium
  tail: 0.18, // what it costs when it goes wrong
  liquidity: 0.12, // can you actually get filled, and out
  volRich: 0.1, // is THIS strike's vol rich, not just the ATM
  touch: 0.1, // will it be tested (management pain, not just expiry risk)
};

/** Bounded tilt (CONV points) for agreeing with the direction engine's regime. */
const REGIME_TILT = 8;

export interface ScreenOptions {
  /** Decision-horizon directional score, −10..+10. Drives drift + the side tilt. */
  score?: number | null;
  regime?: RegimeResult | null;
  /** Contract size in kg. Defaults to the feed symbol's lot. */
  lotUnits?: number;
  /** Broker's real margin per lot, if known — replaces the modelled estimate. */
  marginOverridePerLot?: number | null;
}

// --- Volatility smile -------------------------------------------------------

export interface SmileFit {
  /** Fitted IV at log-moneyness x = ln(K/F). */
  at: (x: number) => number;
  /** Median absolute deviation of the fit residuals, in vol fractions. */
  mad: number;
  n: number;
}

/**
 * Least-squares quadratic in log-moneyness through the chain's OTM IVs. Its job
 * is not to be a pricing model — it is the reference that exposes a leg whose
 * "IV" is really a days-old print (those sit far off an otherwise smooth smile).
 * Returns null when there is not enough of a chain to say anything.
 */
export function fitSmile(chain: OptionQuote[], F: number, minOi: number): SmileFit | null {
  if (!(F > 0)) return null;
  const pts: { x: number; y: number }[] = [];
  for (const o of chain) {
    const otm = o.type === "CE" ? o.strike > F : o.strike < F;
    if (!otm || o.strike <= 0) continue;
    if (o.iv == null || !(o.iv > 0)) continue;
    if ((o.oi ?? 0) < minOi) continue; // legs quiet enough to be stale don't define the smile
    pts.push({ x: Math.log(o.strike / F), y: o.iv });
  }
  if (pts.length < 5) return null;

  // Normal equations for y = c0 + c1·x + c2·x², solved by Gaussian elimination.
  const s = [0, 0, 0, 0, 0];
  const tv = [0, 0, 0];
  for (const { x, y } of pts) {
    s[0] += 1; s[1] += x; s[2] += x * x; s[3] += x ** 3; s[4] += x ** 4;
    tv[0] += y; tv[1] += y * x; tv[2] += y * x * x;
  }
  const M = [
    [s[0], s[1], s[2], tv[0]],
    [s[1], s[2], s[3], tv[1]],
    [s[2], s[3], s[4], tv[2]],
  ];
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) return null; // degenerate — refuse rather than fabricate
    for (let k = i + 1; k < 3; k++) {
      const f = M[k][i] / M[i][i];
      for (let j = i; j < 4; j++) M[k][j] -= f * M[i][j];
    }
  }
  const c = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let acc = M[i][3];
    for (let j = i + 1; j < 3; j++) acc -= M[i][j] * c[j];
    c[i] = acc / M[i][i];
  }
  const at = (x: number) => c[0] + c[1] * x + c[2] * x * x;

  const resid = pts.map((p) => Math.abs(p.y - at(p.x))).sort((a, b) => a - b);
  const mad = resid[Math.floor(resid.length / 2)];
  return { at, mad, n: pts.length };
}

// --- Forecast measure -------------------------------------------------------

export interface Forecast {
  vol: number; // forecast vol, fraction
  drift: number; // annualized drift, fraction
  measure: Measure;
  t: number; // tenor in years
}

/**
 * The seller's own view of where the future lands: vol blended down from IV
 * toward realized, plus a bounded drift from the direction engine. This is the
 * bridge that makes P(OTM) a FORECAST rather than a restatement of 1−|Δ|.
 */
export function buildForecast(mcx: McxData, score: number | null | undefined): Forecast | null {
  const F = mcx.mcx.fut;
  const dte = mcx.mcx.optionDte ?? mcx.mcx.dte;
  const iv = mcx.options.atmIv;
  const rv = mcx.options.rv20;
  if (F == null || dte == null || dte <= 0) return null;
  if (iv == null && rv == null) return null;

  const vol = iv != null && rv != null ? RV_WEIGHT * rv + (1 - RV_WEIGHT) * iv : (rv ?? iv)!;
  if (!(vol > 0)) return null;
  const t = dte / 365;
  const drift = (clamp(score ?? 0, -10, 10) / 10) * MAX_DRIFT_SIGMA * vol;
  const measure = lognormalMeasure(F, vol, t, drift);
  if (!measure) return null;
  return { vol, drift, measure, t };
}

// --- Data confidence --------------------------------------------------------

/**
 * Shrink every score when the inputs behind it are proxied or stale, rather
 * than showing a confident-looking list built on a realized-vol stand-in. Same
 * discipline as horizonConfidence() in scoring.ts.
 */
function dataConfidence(mcx: McxData): number {
  let c = 1;
  if (mcx.stale) c *= 0.7;
  if (mcx.estimated) c *= 0.7;
  if (mcx.options.ivEstimated) c *= 0.75; // IV is a realized-vol proxy
  else if (mcx.options.ivRankEstimated) c *= 0.9; // IV real, its ranking history isn't
  return clamp(c, 0, 1);
}

// --- The screen -------------------------------------------------------------

export function screenSellCandidates(mcx: McxData, opts: ScreenOptions = {}): SellScreen {
  const F = mcx.mcx.fut;
  const chain = mcx.options.chain ?? [];
  const forecast = buildForecast(mcx, opts.score);
  const metal = metalForSymbol(mcx.mcx.symbol);
  const cfg = metal.screen;
  const lotUnits = opts.lotUnits ?? lotUnitsForSymbol(mcx.mcx.symbol);
  const confidence = dataConfidence(mcx);
  // Whole-chain liquidity gate. Ranking a chain nobody trades produces a
  // confident-looking shortlist of unfillable strikes, which is worse than
  // showing nothing — so we refuse to rank and say why.
  const chainOi = chain.reduce((a, o) => a + (o.oi ?? 0), 0);
  const tooThin = cfg.minChainOi > 0 && chainOi < cfg.minChainOi;

  if (F == null || !forecast || !chain.length || tooThin) {
    return {
      candidates: [],
      forecastVol: forecast?.vol ?? null,
      drift: forecast?.drift ?? null,
      lotUnits,
      confidence,
      smileFitted: false,
      chainOi,
      tooThin,
      minChainOi: cfg.minChainOi,
    };
  }

  const { measure, vol: sigF, t } = forecast;
  const smile = fitSmile(chain, F, cfg.minOi);
  const minPremium = FILTERS.minPremiumPctF * F;
  const favoured = favouredSide(opts.regime ?? null);

  const candidates: SellCandidate[] = [];
  for (const o of chain) {
    const otm = o.type === "CE" ? o.strike > F : o.strike < F;
    if (!otm || !(o.strike > 0) || !(o.ltp > 0)) continue;

    const reasons: string[] = [];
    const x = Math.log(o.strike / F);

    // --- hard filters ---
    if (o.iv == null || !(o.iv > 0)) reasons.push("noIV");
    else if (smile) {
      const tol = Math.max(FILTERS.smileTolMad * smile.mad, FILTERS.smileTolVolPts);
      if (Math.abs(o.iv - smile.at(x)) > tol) reasons.push("offSmile");
    }
    if ((o.oi ?? 0) < cfg.minOi) reasons.push("thinOI");
    if (o.ltp < minPremium) reasons.push("tinyPrem");

    // Strike IV where it is trustworthy, ATM IV as the fallback, so a rejected
    // leg still gets a comparable row instead of a blank one.
    const strikeIv = o.iv != null && o.iv > 0 && !reasons.includes("offSmile")
      ? o.iv
      : mcx.options.atmIv ?? sigF;
    const cushion = cushionSigma(F, o.strike, strikeIv, t);
    if (cushion < FILTERS.minCushionSigma) reasons.push("tooClose");

    // --- metrics ---
    const fair = fairValueUnder(o.strike, o.type, measure);
    const margin = spanScanMargin(F, o.strike, t, strikeIv, o.type, {
      priceScan: cfg.priceScan,
      volScan: cfg.volScan,
    });
    const edge = o.ltp - fair; // ₹/kg expected edge over the tenor
    const edgePct = margin > 0 ? (edge / margin) * 100 : 0;
    const romAnnual = margin > 0 && t > 0 ? (edge / margin / t) * 100 : 0;
    const cvar = cvarShort(o.strike, o.type, o.ltp, measure);
    const tailPct = margin > 0 ? (cvar / margin) * 100 : 0;
    const pOtm = probOtm(o.strike, o.type, measure);
    const touch = probabilityOfTouch(F, o.strike, strikeIv, t);
    const delta = black76Delta(F, o.strike, t, strikeIv, o.type);

    // --- sub-scores, each 0..1 ---
    const sub = {
      ret: clamp(romAnnual / cfg.romDivisor, 0, 1),
      safety: clamp((pOtm - 0.8) / 0.15, 0, 1),
      tail: clamp(1 - (tailPct / 100 - 0.5) / 1.2, 0, 1),
      liquidity: clamp(Math.log10(Math.max(o.oi ?? 0, 1) / 100) / 1.5, 0, 1),
      volRich: clamp((strikeIv / sigF - 1) / 0.5, 0, 1),
      touch: clamp(1 - (touch - 0.1) / 0.35, 0, 1),
    };
    let conv = 100 * (
      CONV_WEIGHTS.ret * sub.ret +
      CONV_WEIGHTS.safety * sub.safety +
      CONV_WEIGHTS.tail * sub.tail +
      CONV_WEIGHTS.liquidity * sub.liquidity +
      CONV_WEIGHTS.volRich * sub.volRich +
      CONV_WEIGHTS.touch * sub.touch
    );
    // The regime tilt is bounded and only applies when the direction engine
    // itself says its lean is usable.
    const withRegime = favoured == null ? null : favoured === o.type;
    if (withRegime === true) conv += REGIME_TILT;
    else if (withRegime === false) conv -= REGIME_TILT;
    conv = clamp(conv * confidence, 0, 100);

    candidates.push({
      strike: o.strike,
      type: o.type,
      conv: Math.round(conv),
      premium: o.ltp,
      credit: o.ltp * lotUnits,
      iv: strikeIv,
      ivQuoted: o.iv,
      ivFitted: smile ? smile.at(x) : null,
      delta,
      cushion,
      pOtm,
      touch,
      fair,
      edge,
      edgePct,
      romAnnual,
      margin,
      marginPerLot: (opts.marginOverridePerLot ?? null) ?? margin * lotUnits,
      marginModelled: opts.marginOverridePerLot == null,
      cvar,
      tailPct,
      breakeven: o.type === "CE" ? o.strike + o.ltp : o.strike - o.ltp,
      oi: o.oi ?? 0,
      oiChg: o.oiChg ?? null,
      thin: (o.oi ?? 0) < cfg.thinOi,
      withRegime,
      ok: reasons.length === 0,
      reasons,
      sub,
    });
  }

  // Ties break toward the deeper book: between two equally-scored strikes, the
  // one you can actually get out of is the better sale.
  candidates.sort((a, b) => b.conv - a.conv || b.oi - a.oi);
  return {
    candidates,
    forecastVol: sigF,
    drift: forecast.drift,
    lotUnits,
    confidence,
    smileFitted: smile != null,
    chainOi,
    tooThin: false,
    minChainOi: cfg.minChainOi,
  };
}

/** Which side the regime favours selling, or null when no lean is warranted. */
function favouredSide(regime: RegimeResult | null): "CE" | "PE" | null {
  if (!regime || !regime.directionalLeanAllowed) return null;
  if (regime.regime === "trend_up") return "PE"; // rising → sell puts
  if (regime.regime === "trend_down") return "CE";
  return null;
}

/** Seller-status band for a candidate, matching PositionsPanel's vocabulary. */
export function candidateTone(c: SellCandidate): "bull" | "warn" | "bear" {
  if (c.pOtm < 0.85 || c.cushion < 0.8) return "bear";
  if (c.pOtm < 0.92 || c.cushion < 1.1) return "warn";
  return "bull";
}
