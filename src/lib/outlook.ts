// ---------------------------------------------------------------------------
// Market Outlook engine. Synthesizes the live factor engine + structural themes
// into a weighted, narrative 30-day silver outlook.
//
// Framework adapted from a 5-month "reports vs price" backtest (crude oil):
//   * weight timely surprises (macro/inventory/geopolitics) heaviest,
//   * outlooks (supply/demand) moderate,
//   * positioning (CoT / OI) as a contrarian override,
//   * an ensemble beats any single signal (~70% vs ~60% hit, ~0.35 corr),
//   * vol-timing from news has no edge -> sell premium on IV richness.
// Silver analogues: inventories -> COMEX/SLV flows; OPEC/IEA -> Silver
// Institute / solar demand; macro (yields/DXY/gold) is silver's biggest driver.
// ---------------------------------------------------------------------------

import type {
  Horizon,
  HorizonScore,
  LiveInputs,
  McxData,
  PremiumSellScore,
  RegimeResult,
} from "./types";

export type Stance = "up" | "down" | "neutral";

export interface OutlookDriver {
  category: string;
  stance: Stance;
  weight: number; // % of the outlook
  note: string;
  live: boolean; // backed by live data vs structural/curated
}

export interface Outlook {
  leanLabel: string;
  leanTone: "bull" | "bear" | "neutral" | "warn";
  horizonScore: number;
  confidence: number;
  netBias: number; // -10..+10 weighted across drivers
  drivers: OutlookDriver[];
  positioning: string;
  volNote: string;
  playbook: string;
  summary: string;
}

function stanceOf(s: number): Stance {
  return s > 0.12 ? "up" : s < -0.12 ? "down" : "neutral";
}
function stanceVal(s: Stance): number {
  return s === "up" ? 1 : s === "down" ? -1 : 0;
}

export function buildOutlook(
  _live: LiveInputs,
  mcx: McxData,
  scores: Record<Horizon, HorizonScore>,
  regime: RegimeResult,
  premium: PremiumSellScore | null,
  derived: { premiumPct: number | null; gsr: number | null } | null,
): Outlook {
  const f1m = scores["1M"];
  const liveStance = (keys: string[]): Stance | null => {
    let sum = 0, cnt = 0;
    for (const k of keys) {
      const f = f1m.factors.find((x) => x.key === k);
      if (f && f.present) { sum += f.s; cnt++; }
    }
    return cnt ? stanceOf(sum / cnt) : null;
  };

  const drivers: OutlookDriver[] = [];
  const add = (category: string, weight: number, stance: Stance | null, curated: Stance, note: string) =>
    drivers.push({ category, weight, stance: stance ?? curated, live: stance !== null, note });

  // 1) Monetary — silver's biggest driver (real yields, dollar, Fed path).
  const mon = liveStance(["real10y", "dxy"]);
  add("Monetary · Fed & real yields", 22, mon, "down",
    mon === null
      ? "Fed holding with a hawkish lean and sticky real yields — a headwind. A turn lower in yields/USD would flip this the single biggest tailwind. (Add a FRED key to make this live.)"
      : mon === "down"
        ? "Real yields / a firm dollar are weighing on silver — the dominant macro headwind right now."
        : "Easing real yields / a softer dollar are supporting silver — the dominant macro tailwind.");

  // 2) Gold leadership — silver is a high-beta follower.
  const gold = liveStance(["goldMomo"]);
  add("Gold leadership", 12, gold, "neutral",
    gold === "up" ? "Gold is trending up and silver follows with higher beta — supportive."
      : gold === "down" ? "Gold is rolling over; silver tends to fall harder — a drag."
        : "Gold is rangebound — little directional pull on silver.");

  // 3) Silver's own trend.
  const sil = liveStance(["silverMomo"]);
  add("Silver price trend", 16, sil, "neutral",
    sil === "up" ? "Silver's own momentum is positive (above its moving averages)."
      : sil === "down" ? "Silver is trending below its moving averages — momentum is negative."
        : "Silver is consolidating — no clear momentum either way.");

  // 4) Structural deficit + industrial demand — a slow floor.
  add("Structural deficit & industrial demand", 16, "up", "up",
    "6th straight annual supply deficit + solar/EV/AI demand = a slow structural floor under price. PV thrifting is a mild offset; not a 30-day catalyst, but it caps downside over time.");

  // 5) Inventory & ETF flows — the most timely surprise signal (watch).
  add("Inventory & ETF flows", 4, null, "neutral",
    "Watch COMEX/LBMA stocks & SLV holdings — the most timely surprise signal (a sudden draw is bullish, a build bearish). Not yet wired live — the next data add.");

  // 6) Positioning — CoT extremes (contrarian override) + MCX OI.
  const pos = liveStance(["mcxPositioning"]);
  const oiChg = mcx.mcx.oiChg;
  const cot = mcx.cot ?? null;
  const oiTxt = oiChg == null ? "" : oiChg > 0 ? "Rising OI = fresh conviction behind the move. " : "Falling OI = covering-driven move (can exhaust). ";
  let posStance: Stance | null = pos;
  let posNote: string;
  if (cot) {
    if (cot.percentile >= 80) {
      posStance = "down";
      posNote = `${oiTxt}Speculators (${cot.source}) sit at the ${cot.percentile}th percentile net long — a crowded one-sided book. Contrarian caution for bulls, and tailwind-risk for short calls.`;
    } else if (cot.percentile <= 20) {
      posStance = "up";
      posNote = `${oiTxt}Speculators (${cot.source}) are at the ${cot.percentile}th percentile (lightly long / crowded short) — a contrarian positive and potential squeeze fuel.`;
    } else {
      posNote = `${oiTxt}Speculator positioning (${cot.source}) is mid-range (${cot.percentile}th pctile) — no crowding extreme to fade.`;
    }
  } else {
    posNote = oiChg == null ? "Positioning data pending." : `${oiTxt}(CoT positioning pending.)`;
  }
  add("Positioning · CoT + MCX OI", 10, posStance, "neutral", posNote);

  // 7) India local — duty, INR, basis premium.
  const inr = liveStance(["usdInr"]);
  const pp = derived?.premiumPct ?? null;
  const indiaStance: Stance = pp != null && pp > 0.5 ? "up" : pp != null && pp < -0.5 ? "down" : (inr ?? "neutral");
  add("India local · INR, duty & basis", 14, indiaStance, indiaStance,
    pp != null && pp > 0.5
      ? `MCX holds a ${pp.toFixed(1)}% premium to import-parity — local tightness (15% duty + curbs) is supportive; a weaker rupee lifts it further even if global silver is flat.`
      : pp != null && pp < -0.5
        ? `MCX trades at a ${Math.abs(pp).toFixed(1)}% discount — soft local demand; MCX may lag global silver.`
        : "MCX near import-parity; INR direction is the swing factor for the local price.");

  // 8) Relative value — GSR.
  const gsr = liveStance(["gsr"]);
  add("Relative value · gold-silver ratio", 6, gsr, "neutral",
    gsr === "up" ? "Silver looks cheap vs gold — mild mean-reversion tailwind."
      : gsr === "down" ? "Silver looks rich vs gold — relative valuation is stretched."
        : "Silver fairly valued vs gold.");

  // Weighted net bias.
  const totW = drivers.reduce((a, d) => a + d.weight, 0) || 1;
  const netBias = Math.round((drivers.reduce((a, d) => a + stanceVal(d.stance) * d.weight, 0) / totW) * 100) / 10;

  const r = regime.regime;
  const leanLabel = r === "trend_up" ? "Bullish lean" : r === "trend_down" ? "Bearish lean"
    : r === "chop" ? "Range-bound / two-sided" : "No strong edge";
  const leanTone: Outlook["leanTone"] = r === "trend_up" ? "bull" : r === "trend_down" ? "bear"
    : r === "chop" ? "neutral" : "warn";

  // Seller playbook (direction + the backtest's risk lesson + vol discipline).
  const side = r === "trend_up" ? "selling puts / put-credit spreads"
    : r === "trend_down" ? "selling calls / call-credit spreads"
      : "selling a wide, symmetric strangle";
  const volPart = premium
    ? premium.band === "green" ? `IV is rich (sell-window ${premium.score}/100) — favorable to sell now.`
      : premium.band === "amber" ? `IV is middling (sell-window ${premium.score}/100) — be selective on entry.`
        : `IV is thin (sell-window ${premium.score}/100) — size down or wait for richer vol.`
    : "";
  const playbook = `Express the lean via ${side}. ${volPart} When signals stack against your short side, widen those strikes for cushion — the backtest's main risk lesson. Harvest IV richness; don't try to time vol off news (it had no measured edge).`;

  const volNote = premium
    ? `Premium-sell window ${premium.score}/100 (${premium.band}). The research found news-driven vol-timing has no edge, so the seller's job is to sell when implied > realized — exactly what this score measures.`
    : "Sell premium when implied vol is rich vs realized.";

  const cotTxt = cot
    ? cot.percentile >= 80
      ? ` Specs are crowded long (CoT ${cot.percentile}th pctile) — a contrarian red flag; fade-risk is elevated for bulls.`
      : cot.percentile <= 20
        ? ` Specs are crowded short (CoT ${cot.percentile}th pctile) — contrarian fuel for a bounce/squeeze.`
        : ` CoT net positioning is mid-range (${cot.percentile}th pctile) — no extreme to fade.`
    : "";
  const positioning =
    (oiChg == null ? "OI change pending." : oiChg > 0 ? "Rising OI = fresh conviction behind the move." : "Falling OI = covering-driven move; watch for exhaustion.") + cotTxt;

  const topDrivers = [...drivers].filter((d) => d.stance !== "neutral").sort((a, b) => b.weight - a.weight).slice(0, 2);
  const driverTxt = topDrivers.map((d) => `${d.category.split(" · ")[0].toLowerCase()} (${d.stance === "up" ? "↑" : "↓"})`).join(" and ");
  const summary =
    `Over the next ~30 days the weighted read is a ${leanLabel.toLowerCase()} (engine ${f1m.score >= 0 ? "+" : ""}${f1m.score.toFixed(1)}, ${(f1m.confidence * 100).toFixed(0)}% confidence)` +
    `${driverTxt ? `, driven mainly by ${driverTxt}` : ""}. ` +
    `Treat it as a probabilistic lean, not a forecast — the source ensemble ran ~0.35 correlation with weekly returns (modest but real).`;

  return { leanLabel, leanTone, horizonScore: f1m.score, confidence: f1m.confidence, netBias, drivers, positioning, volNote, playbook, summary };
}
