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
  dxy: number | null; // dollar index (ICE DXY, or Fed Broad USD when usdBroad)
  usdBroad?: boolean; // true when `dxy` is the Fed Broad USD Index (~120 scale), not ICE DXY (~97)
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
    expiry: string | null; // future expiry — drives basis convergence
    dte: number | null; // days to FUTURE expiry
    // Option expiry/DTE — the contract an options seller actually trades (MCX
    // silver options expire before the future). Drives theta, expected move,
    // the premium-sell read, and the regime decision horizon. Falls back to the
    // future's expiry when no live option contract is available.
    optionExpiry?: string | null;
    optionDte?: number | null;
    optionExpiries?: string[]; // all upcoming option expiries (for tagging positions)
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
    // true while ivRank/ivPercentile are ranked against realized-vol history;
    // flips false once ≥20 days of real ATM IV accumulate in ivHistory.
    ivRankEstimated?: boolean;
    ivHistory?: Point[]; // daily real ATM IV (accumulated server-side)
    rv20: number | null; // realized vol, fraction
    expectedMove1sd: number | null; // ₹/kg over the option's tenor
    chain: OptionQuote[];
  };
  basis: {
    fairValue: number | null; // ₹/kg theoretical
    basis: number | null; // futures - fairValue
  };
  /** Gamma-exposure read (pinning vs ranging) from the option chain. */
  gex?: GexData | null;
  /** CFTC Commitments of Traders — COMEX silver speculative net positioning. */
  cot?: CotData | null;
  /** Silver-relevant news headlines with auto-tagged impact + source links. */
  news?: NewsItem[];
  /** Recent macro prints (actual vs prior) that move silver. */
  prints?: EconPrint[];
  events: MarketEvent[];
}

/** Gamma exposure summary — EXPERIMENTAL (thin MCX OI, crude dealer assumption). */
export interface GexData {
  netPct: number; // -100..+100; + = long-gamma tilt (pinning), − = short-gamma (volatile)
  regime: "pinning" | "balanced" | "volatile";
  pinStrike: number | null; // strike with the largest gamma×OI concentration
  maxPain: number | null; // strike minimizing total option payout
  callWall: number | null; // biggest call-OI strike (resistance magnet)
  putWall: number | null; // biggest put-OI strike (support magnet)
  coverage: number; // # of option rows backing the estimate
}

/** A recent macro release: what actually printed vs the prior reading. */
export interface EconPrint {
  kind: MarketEvent["kind"];
  name: string;
  period: string; // e.g. "May 26"
  actual: number;
  prior: number;
  unit: string; // "%", "k"
  impact: "up" | "down" | "twoway";
  note: string;
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
  trusted?: boolean; // from the reputable-source whitelist (Reuters, Bloomberg, …)
  indirect?: boolean; // macro driver (Fed/dollar/inflation/gold) rather than silver itself
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
