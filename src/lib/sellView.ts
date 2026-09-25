// ---------------------------------------------------------------------------
// What the Sell tab shows, as a pure function of one snapshot.
//
// The browser and the Telegram alerts (scripts/alerts.mjs) both need the same
// answer to "which strikes are on the screen, and at what CONV?", so the
// pieces that used to live inside the store and the component live here:
//
//   · mergeExpiry  — the expiry selector's view of the snapshot;
//   · the direction score + regime that tilt CONV (same horizon choice as the
//     store: the regime's DTE-matched horizon, keyed off the NEAREST expiry);
//   · the shortlist — `ok` candidates, best CONV first, SELL_TOP_N per side.
//
// If the component and the alerts ever disagree about the displayed list, an
// alert fires for a strike the screen doesn't show. Keep them on this module.
// ---------------------------------------------------------------------------

import type {
  Horizon,
  HorizonScore,
  LiveInputs,
  McxData,
  PremiumSellScore,
  Regime,
  RegimeResult,
  SellCandidate,
  SellScreen,
} from "./types";
import { deriveRegime, premiumSellScore, scoreAllHorizons } from "./scoring";
import { screenSellCandidates } from "./sellCandidates";

/** Rows per side (PUTS / CALLS) the Sell tab lists for one expiry. */
export const SELL_TOP_N = 8;

/**
 * Return an mcx view with the chosen expiry's contract data swapped in, so all
 * option cards (chain, IV, GEX, expected move, theta, market structure, basis)
 * re-point to it. The macro direction (scores/regime) is computed from the base
 * mcx, so it stays global. Selecting the nearest keeps the base (live-overlaid).
 */
export function mergeExpiry(mcx: McxData | null, sel: string | null): McxData | null {
  const exs = mcx?.expiries;
  if (!mcx || !exs?.length || !sel || sel === mcx.mcx.optionExpiry) return mcx;
  const b = exs.find((e) => e.optionExpiry === sel);
  if (!b) return mcx;
  return {
    ...mcx,
    mcx: {
      ...mcx.mcx,
      fut: b.fut,
      prevClose: b.prevClose,
      oi: b.oi,
      oiChg: b.oiChg,
      expiry: b.expiry,
      dte: b.dte,
      optionExpiry: b.optionExpiry,
      optionDte: b.optionDte,
    },
    options: {
      ...mcx.options,
      atmStrike: b.atmStrike,
      atmIv: b.atmIv,
      ivEstimated: b.ivEstimated,
      ivRank: b.ivRank,
      ivPercentile: b.ivPercentile,
      ivRankEstimated: b.ivRankEstimated,
      expectedMove1sd: b.expectedMove1sd,
      chain: b.chain,
    },
    gex: b.gex,
    basis: b.basis,
  };
}

/** The decision-horizon score the Sell tab feeds the screener (drift + tilt). */
export function decisionScore(
  scores: Record<Horizon, HorizonScore> | null,
  regime: RegimeResult | null,
): number | null {
  return regime ? scores?.[regime.dteHorizon].score ?? null : null;
}

/** The Sell tab's list for one side: survivors only, best first, capped. */
export function shortlist(screen: SellScreen, side: "CE" | "PE"): SellCandidate[] {
  return screen.candidates.filter((c) => c.ok && c.type === side).slice(0, SELL_TOP_N);
}

export interface ExpiryView {
  optionExpiry: string | null;
  optionDte: number | null;
  fut: number | null;
  /** Every OTM leg scored on this expiry (rejects included, `ok` false). */
  screen: SellScreen;
  /** Exactly what the Sell tab lists for each side. */
  shown: { PE: SellCandidate[]; CE: SellCandidate[] };
  /** The VRP / event gates the Sell tab prints above the list. */
  gates: PremiumSellScore;
}

export interface SellView {
  scores: Record<Horizon, HorizonScore>;
  regime: RegimeResult;
  score: number | null;
  expiries: ExpiryView[];
}

/**
 * Every expiry's Sell tab for one snapshot. `prevRegime` is the hysteresis
 * memory the store keeps per metal; `now` dates the event gate.
 */
export function sellView(
  live: LiveInputs,
  mcx: McxData,
  prevRegime: Regime | undefined,
  now: Date,
): SellView {
  const scores = scoreAllHorizons(live, mcx); // base mcx → direction is expiry-independent
  const regime = deriveRegime(scores, mcx.mcx.optionDte ?? mcx.mcx.dte, prevRegime);
  const score = decisionScore(scores, regime);
  const picks = mcx.expiries?.length ? mcx.expiries.map((e) => e.optionExpiry) : [null];
  const expiries = [...new Set(picks)].map((sel) => {
    const view = mergeExpiry(mcx, sel)!;
    const screen = screenSellCandidates(view, { score, regime });
    return {
      optionExpiry: view.mcx.optionExpiry ?? null,
      optionDte: view.mcx.optionDte ?? view.mcx.dte,
      fut: view.mcx.fut,
      screen,
      shown: { PE: shortlist(screen, "PE"), CE: shortlist(screen, "CE") },
      gates: premiumSellScore(view, view.events, now),
    };
  });
  return { scores, regime, score, expiries };
}
