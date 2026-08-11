// ---------------------------------------------------------------------------
// Per-metal narrative copy for the Outlook tab.
//
// Separated from metals.mjs on purpose: that file is configuration the data
// builder also reads (units, parity, feeds, weights), this is prose only the
// client renders. Keeping them apart stops the builder importing paragraphs.
//
// The point of this file is that silver's story is NOT gold's story is NOT
// copper's story. Before it existed, every metal's Outlook tab said "6th
// straight annual supply deficit + solar/EV demand" — true of silver, false and
// misleading on a copper screen.
// ---------------------------------------------------------------------------

import type { Stance } from "./outlook";

export interface DriverCopy {
  label: string;
  up: string;
  down: string;
  flat: string;
}

export interface MetalCopy {
  /** Cross-metal driver: gold leadership for silver, the growth ratio for copper. */
  lead: (DriverCopy & { key: string; weight: number }) | null;
  /** The metal's own trend. */
  trend: DriverCopy;
  /** Relative-value ratio. */
  ratio: (DriverCopy & { key: string; weight: number }) | null;
  /** Constant structural story — weight and text, no live input. */
  structural: { label: string; weight: number; note: string };
  /** Physical/flows watch item. Marked not-wired until a feed backs it. */
  flows: { label: string; weight: number; note: string };
  /** Monetary driver wording (real yields + dollar). */
  monetary: DriverCopy & { weight: number };
  /** India-local wording; `{duty}` is substituted with the metal's duty %. */
  local: { label: string; weight: number; premium: string; discount: string; parity: string };
}

const COPY: Record<string, MetalCopy> = {
  silver: {
    lead: {
      key: "goldMomo",
      weight: 12,
      label: "Gold leadership",
      up: "Gold is trending up and silver follows with higher beta — supportive.",
      down: "Gold is rolling over; silver tends to fall harder — a drag.",
      flat: "Gold is rangebound — little directional pull on silver.",
    },
    trend: {
      label: "Silver price trend",
      up: "Silver's own momentum is positive (above its moving averages).",
      down: "Silver is trending below its moving averages — momentum is negative.",
      flat: "Silver is consolidating — no clear momentum either way.",
    },
    ratio: {
      key: "gsr",
      weight: 6,
      label: "Relative value · gold-silver ratio",
      up: "Silver looks cheap vs gold — mild mean-reversion tailwind.",
      down: "Silver looks rich vs gold — relative valuation is stretched.",
      flat: "Silver fairly valued vs gold.",
    },
    structural: {
      label: "Structural deficit & industrial demand",
      weight: 16,
      note: "A multi-year run of annual supply deficits plus solar/EV/AI demand puts a slow structural floor under price. PV thrifting is a mild offset. Not a 30-day catalyst, but it caps downside over time.",
    },
    flows: {
      label: "Inventory & ETF flows",
      weight: 4,
      note: "COMEX/LBMA stocks and SLV holdings are the most timely surprise signal — a sudden draw is bullish, a build bearish.",
    },
    monetary: {
      weight: 22,
      label: "Monetary · Fed & real yields",
      up: "Easing real yields / a softer dollar are supporting silver — the dominant macro tailwind.",
      down: "Real yields / a firm dollar are weighing on silver — the dominant macro headwind right now.",
      flat: "Real yields and the dollar are directionless — the macro pillar is neutral.",
    },
    local: {
      label: "India local · INR, duty & basis",
      weight: 14,
      premium: "local tightness ({duty}% duty + import curbs) is supportive; a weaker rupee lifts it further even if global silver is flat.",
      discount: "soft local demand; MCX may lag global silver.",
      parity: "MCX near import-parity; INR direction is the swing factor for the local price.",
    },
  },

  gold: {
    // No leadership driver — gold IS the leader of the complex.
    lead: null,
    trend: {
      label: "Gold price trend",
      up: "Gold's own momentum is positive (above its moving averages).",
      down: "Gold is trending below its moving averages — momentum is negative.",
      flat: "Gold is consolidating — no clear momentum either way.",
    },
    ratio: {
      key: "gsrGold",
      weight: 6,
      label: "Relative value · gold-silver ratio",
      up: "Gold looks cheap vs silver — mild relative tailwind.",
      down: "Gold is rich relative to silver — stretched on relative value, and silver tends to outrun it in a metals rally.",
      flat: "Gold fairly valued vs silver.",
    },
    structural: {
      label: "Central-bank demand",
      weight: 12,
      note: "Sustained official-sector buying has been a persistent floor under gold — reserve diversification is a multi-year flow, not a monthly one. A level story rather than a timing signal, so it is weighted below silver's deficit prior.",
    },
    flows: {
      label: "ETF flows & COMEX stocks",
      weight: 6,
      note: "GLD tonnage and COMEX registered stocks are the timeliest read on investor demand — sustained inflows confirm a trend, outflows into strength are a warning.",
    },
    monetary: {
      weight: 26,
      label: "Monetary · Fed & real yields",
      up: "Falling real yields / a softer dollar are supporting gold. This is gold's single most reliable driver — it outranks everything else here.",
      down: "Rising real yields / a firm dollar are the classic gold headwind, and the most reliable signal on this page.",
      flat: "Real yields and the dollar are directionless — gold's dominant driver is offering no edge.",
    },
    local: {
      label: "India local · INR, duty & basis",
      weight: 14,
      premium: "local tightness ({duty}% duty + import curbs) is supportive, and festive/wedding demand amplifies it; a weaker rupee lifts MCX further even if COMEX is flat.",
      discount: "soft local demand or heavy scrap supply; MCX may lag global gold.",
      parity: "MCX near import-parity; INR direction is the swing factor for the local price.",
    },
  },

  copper: {
    lead: {
      key: "copperGold",
      weight: 12,
      label: "Growth · copper/gold ratio",
      up: "Copper is outrunning gold — the market is pricing reflation and industrial demand. The cleanest risk-on confirmation for the red metal.",
      down: "Copper is lagging gold — a growth scare is being priced. Historically the earliest warning for industrial metals.",
      flat: "Copper and gold are moving together — no clear growth signal either way.",
    },
    trend: {
      label: "Copper price trend",
      up: "Copper's own momentum is positive (above its moving averages).",
      down: "Copper is trending below its moving averages — momentum is negative.",
      flat: "Copper is consolidating — no clear momentum either way.",
    },
    // No bullion ratio for copper — the growth ratio above already carries it.
    ratio: null,
    structural: {
      label: "Supply · concentrate tightness & electrification",
      weight: 16,
      note: "Spot treatment charges have gone negative — smelters paying miners for concentrate, the clearest sign of raw-material scarcity there is — while grid build-out, EVs and data centres add demand. Deliberately weighted below silver's deficit prior: copper's tightness is more cyclical and can unwind fast.",
    },
    flows: {
      label: "Inventories · LME, SHFE & COMEX",
      weight: 10,
      note: "Exchange stocks are copper's single most timely signal: falling inventories with the LME in backwardation means genuine physical tightness, a build means the opposite. The US Section 232 tariff has also pulled metal into COMEX and out of LME, so read the three venues together — a COMEX build alongside an LME draw is relocation, not demand.",
    },
    monetary: {
      weight: 14,
      label: "Monetary · dollar & rates",
      up: "A softer dollar is supporting copper. Note the dollar matters MORE here than for bullion — copper has no safe-haven bid to offset dollar strength — while real yields matter far less.",
      down: "A firm dollar is weighing on copper, with no haven bid to cushion it.",
      flat: "The dollar is directionless — little macro push either way.",
    },
    local: {
      label: "India local · INR & basis",
      weight: 14,
      premium: "MCX is above import parity ({duty}% duty) — but note copper's parity here is anchored to COMEX while MCX tracks LME, so read the direction rather than the level.",
      discount: "MCX is below import parity — soft local demand, though the COMEX-anchored benchmark makes the level unreliable.",
      parity: "MCX near import parity; INR direction is the swing factor. Copper's parity anchor is approximate — see the basis card.",
    },
  },
};

export function copyFor(metalId: string): MetalCopy {
  return COPY[metalId] ?? COPY.silver;
}

/** Pick the wording for a stance, defaulting to the flat case. */
export function say(c: DriverCopy, stance: Stance | null): string {
  return stance === "up" ? c.up : stance === "down" ? c.down : c.flat;
}
