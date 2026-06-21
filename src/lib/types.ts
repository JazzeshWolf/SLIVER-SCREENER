// ---------------------------------------------------------------------------
// Shared domain types for Sliver Screener.
// ---------------------------------------------------------------------------

export type Horizon = "1D" | "1W" | "1M";
export type Trend = "up" | "down" | "flat";
export type Regime = "trend_up" | "trend_down" | "chop" | "no_conviction";

/** A normalized time series point: ISO date + numeric value. */
export interface Point {
  t: string; // ISO date (YYYY-MM-DD) or ISO datetime
  v: number;
}

/** Live, browser-fetched market inputs (international + FX + rates). */
export interface LiveInputs {
  xagUsd: number | null; // silver spot, $/oz
  xauUsd: number | null; // gold spot, $/oz
  usdInr: number | null; // ₹ per $
  dxy: number | null; // US dollar index
  real10y: number | null; // 10y TIPS real yield, % (FRED DFII10)
  breakeven10y: number | null; // 10y breakeven inflation, % (DGS10 - DFII10)
  // Short history for momentum/z-scores (oldest -> newest). May be empty.
  xagHistory: Point[];
  xauHistory: Point[];
  dxyHistory: Point[];
  real10yHistory: Point[];
  usdInrHistory: Point[];
  asOf: string; // ISO timestamp of the freshest live input
  partial: boolean; // true if any source failed and fell back to cache/null
}

export interface OptionQuote {
  strike: number;
  type: "CE" | "PE";
  ltp: number; // last price (premium), ₹
  iv: number | null; // implied vol, fraction (0.30 = 30%)
  oi: number;
}

/** MCX-specific data, produced server-side by the GitHub Action -> latest.json. */
export interface McxData {
  asOf: string;
  stale: boolean; // true if the Action could not refresh and served last-good
  partial: boolean;
  // When true, MCX price/IV are derived from international parity + realized vol
  // (no live exchange feed available), and should be labelled as estimates.
  estimated?: boolean;
  mcx: {
    symbol: string;
    silverFut: number | null; // ₹/kg
    prevClose: number | null;
    expiry: string | null; // ISO date
    dte: number | null;
    oi: number | null;
    oiChg: number | null;
  };
  options: {
    atmStrike: number | null;
    atmIv: number | null; // fraction
    // true when atmIv is a realized-vol proxy (no traded option price), and/or
    // ivRank/ivPercentile are ranked against realized-vol history rather than a
    // real ATM-IV history. The UI labels these so a proxy never reads as live IV.
    ivEstimated?: boolean;
    ivRank: number | null; // 0..100
    ivPercentile: number | null; // 0..100
    rv20: number | null; // realized vol, fraction
    expectedMove1sd: number | null; // ₹/kg over the option's tenor
    chain: OptionQuote[];
  };
  basis: {
    fairValue: number | null; // ₹/kg theoretical
    basis: number | null; // futures - fairValue
  };
  /** CFTC Commitments of Traders — COMEX silver speculative net positioning. */
  cot?: CotData | null;
  /** Silver-relevant news headlines with auto-tagged impact + source links. */
  news?: NewsItem[];
  events: MarketEvent[];
}

export interface CotData {
  net: number; // speculative net position (contracts)
  percentile: number; // 0..100 vs trailing history (extreme = crowded)
  asOf: string; // ISO report date (weekly, ~3-day lag)
  source: string; // "managed money" | "non-commercial"
  history: Point[]; // net position history
}

export interface NewsItem {
  title: string;
  url: string; // links back to the original publisher
  source: string;
  publishedAt: string; // ISO
  snippet: string;
  impact: "up" | "down" | "twoway"; // auto-tagged silver impact
}

/** The single server-built data file the client renders (built by the Action). */
export interface Snapshot {
  live: LiveInputs;
  mcx: McxData;
}

export interface MarketEvent {
  name: string;
  date: string; // ISO date
  kind: "fomc" | "us_cpi" | "us_jobs" | "rbi" | "mcx_expiry" | "other";
  /** Net directional lean for silver: "up", "down", or "twoway" (data-dependent). */
  impact?: "up" | "down" | "twoway";
  /** Importance 1 (minor) … 3 (major mover). */
  weight?: 1 | 2 | 3;
  /** One-line mechanism: how this event moves silver. */
  effect?: string;
}

/** One factor's contribution within a horizon's directional score. */
export interface FactorContribution {
  key: string;
  label: string;
  raw: number | null; // the underlying measured value (e.g. z-score), null if missing
  s: number; // normalized signal in [-1, +1]
  weight: number; // effective weight (after redistribution), sums to ~1 across present factors
  present: boolean;
}

export interface HorizonScore {
  horizon: Horizon;
  score: number; // -10..+10 (already confidence-scaled)
  rawScore: number; // -10..+10 before confidence scaling
  confidence: number; // 0..1
  bucket: "bullish" | "neutral" | "bearish";
  factors: FactorContribution[];
  partial: boolean; // some factors were missing
}

export interface RegimeResult {
  regime: Regime;
  label: string; // human label, e.g. "Chop / range"
  structure: string; // recommended structure, e.g. "Sell strangle"
  dteHorizon: Horizon; // which horizon was used as the decision horizon
  directionalLeanAllowed: boolean;
}

export interface PremiumSellScore {
  score: number; // 0..100
  band: "green" | "amber" | "red";
  components: {
    ivRank: number | null;
    ivRvRatio: number | null;
    thetaZone: number | null;
    eventClear: number | null;
  };
  confidence: number; // 0..1
  note: string;
}
