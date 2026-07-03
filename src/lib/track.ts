// ---------------------------------------------------------------------------
// Walk-forward self-check for the direction engine. For each of the last ~60
// trading days we truncate every history to that date, recompute the 1W/1M
// score with the SAME engine, and check whether the sign matched what silver
// actually did over the next 5 / 21 trading days.
//
// Honesty notes: this is a walk-forward consistency check on the app's own
// data — weights are never refit, but it is NOT a rigorous backtest (no costs,
// one asset, short sample). It exists so the gauge reports a measured track
// record instead of implying one.
// ---------------------------------------------------------------------------

import type { LiveInputs, McxData, Point } from "./types";
import { scoreHorizon } from "./scoring";

export interface HitRate {
  n: number; // days with a real lean (|score| >= threshold)
  hits: number;
  rate: number; // 0..1
}
export interface TrackResult {
  w1: HitRate;
  m1: HitRate;
  sampleDays: number;
}

const MIN_LEAN = 2; // only score days where the engine actually leaned
const LOOKAHEAD = { "1W": 5, "1M": 21 } as const;

/** MCX stub for reconstruction: positioning factor absent -> weight redistributes. */
const MCX_STUB: McxData = {
  asOf: "",
  stale: false,
  partial: false,
  mcx: { symbol: "XAG", silverFut: null, prevClose: null, expiry: null, dte: null, oi: null, oiChg: null },
  options: { atmStrike: null, atmIv: null, ivRank: null, ivPercentile: null, rv20: null, expectedMove1sd: null, chain: [] },
  basis: { fairValue: null, basis: null },
  events: [],
};

function truncate(live: LiveInputs, date: string): LiveInputs {
  const cut = (pts: Point[]) => pts.filter((p) => p.t <= date);
  return {
    ...live,
    xagHistory: cut(live.xagHistory),
    xauHistory: cut(live.xauHistory),
    dxyHistory: cut(live.dxyHistory),
    real10yHistory: cut(live.real10yHistory),
    usdInrHistory: cut(live.usdInrHistory),
    partial: false,
  };
}

export function walkForwardHitRate(live: LiveInputs, sampleDays = 60): TrackResult | null {
  const xag = live.xagHistory;
  if (xag.length < 90) return null; // need history + lookahead to say anything

  const counts = { "1W": { n: 0, hits: 0 }, "1M": { n: 0, hits: 0 } };
  const end = xag.length - 1;

  for (const h of ["1W", "1M"] as const) {
    const la = LOOKAHEAD[h];
    const from = Math.max(60, end - la - sampleDays);
    for (let i = from; i <= end - la; i++) {
      const asOf = truncate(live, xag[i].t);
      const hs = scoreHorizon(h, asOf, MCX_STUB);
      if (Math.abs(hs.score) < MIN_LEAN) continue;
      const fwd = xag[i + la].v - xag[i].v;
      if (fwd === 0) continue;
      counts[h].n++;
      if (Math.sign(hs.score) === Math.sign(fwd)) counts[h].hits++;
    }
  }

  const rate = (c: { n: number; hits: number }): HitRate => ({
    n: c.n,
    hits: c.hits,
    rate: c.n > 0 ? c.hits / c.n : 0,
  });
  return { w1: rate(counts["1W"]), m1: rate(counts["1M"]), sampleDays };
}
