// ---------------------------------------------------------------------------
// OWNER'S RULE (2026-09-26): the conviction rating for silver, gold and copper
// works — do not change it. "Let it work."
//
// This file pins every input the CONV score and the direction engine read for
// those three metals: the factor weights, the structural priors, the macro
// pillar, the screener calibration and the CONV blend itself. If a test here
// fails, a change is about to move their CONV (and their Telegram alerts).
// Don't update the numbers to make it pass — ask the owner first.
//
// Adding a commodity (crude, 2026-09-26) must leave these untouched; its own
// numbers live in its own registry entry and are free to tune.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { METALS } from "./metals.mjs";
import { CONV_WEIGHTS } from "./sellCandidates";

const FROZEN = {
  silver: {
    structuralBias: 0.6,
    macroKeys: ["dxy", "real10y"],
    weights: {
      dxy: { "1D": 0.24, "1W": 0.17, "1M": 0.13 },
      real10y: { "1D": 0.18, "1W": 0.14, "1M": 0.12 },
      metalMomo: { "1D": 0.22, "1W": 0.16, "1M": 0.12 },
      goldMomo: { "1D": 0.16, "1W": 0.13, "1M": 0.1 },
      longTrend: { "1D": 0.0, "1W": 0.05, "1M": 0.1 },
      mcxPositioning: { "1D": 0.12, "1W": 0.12, "1M": 0.12 },
      usdInr: { "1D": 0.08, "1W": 0.1, "1M": 0.1 },
      gsr: { "1D": 0.0, "1W": 0.05, "1M": 0.06 },
      structuralBias: { "1D": 0.0, "1W": 0.08, "1M": 0.15 },
    },
    screen: { minOi: 25, thinOi: 500, minChainOi: 0, romDivisor: 250, priceScan: 0.06, volScan: 0.25 },
  },
  gold: {
    structuralBias: 0.2,
    macroKeys: ["dxy", "real10y"],
    weights: {
      dxy: { "1D": 0.26, "1W": 0.18, "1M": 0.14 },
      real10y: { "1D": 0.26, "1W": 0.25, "1M": 0.23 },
      metalMomo: { "1D": 0.24, "1W": 0.18, "1M": 0.14 },
      longTrend: { "1D": 0.0, "1W": 0.06, "1M": 0.11 },
      mcxPositioning: { "1D": 0.12, "1W": 0.12, "1M": 0.12 },
      usdInr: { "1D": 0.12, "1W": 0.12, "1M": 0.12 },
      gsrGold: { "1D": 0.0, "1W": 0.04, "1M": 0.05 },
      structuralBias: { "1D": 0.0, "1W": 0.05, "1M": 0.09 },
    },
    screen: { minOi: 25, thinOi: 300, minChainOi: 0, romDivisor: 150, priceScan: 0.04, volScan: 0.2 },
  },
  copper: {
    structuralBias: 0.3,
    macroKeys: ["dxy", "copperGold"],
    weights: {
      dxy: { "1D": 0.26, "1W": 0.22, "1M": 0.18 },
      real10y: { "1D": 0.06, "1W": 0.05, "1M": 0.04 },
      metalMomo: { "1D": 0.26, "1W": 0.2, "1M": 0.16 },
      copperGold: { "1D": 0.14, "1W": 0.12, "1M": 0.1 },
      longTrend: { "1D": 0.0, "1W": 0.06, "1M": 0.11 },
      mcxPositioning: { "1D": 0.16, "1W": 0.14, "1M": 0.14 },
      usdInr: { "1D": 0.12, "1W": 0.12, "1M": 0.12 },
      structuralBias: { "1D": 0.0, "1W": 0.09, "1M": 0.15 },
    },
    screen: { minOi: 100, thinOi: 250, minChainOi: 1500, romDivisor: 120, priceScan: 0.05, volScan: 0.22 },
  },
};

describe("frozen: silver, gold and copper conviction (owner's rule, 2026-09-26)", () => {
  for (const [id, want] of Object.entries(FROZEN)) {
    it(`${id}: direction weights, prior and macro pillar are unchanged`, () => {
      const e = METALS[id].engine;
      expect(e.weights, id).toEqual(want.weights);
      expect(e.structuralBias, id).toBe(want.structuralBias);
      expect(e.macroKeys, id).toEqual(want.macroKeys);
    });

    it(`${id}: sell-screener calibration is unchanged`, () => {
      expect(METALS[id].screen, id).toEqual(want.screen);
    });
  }

  it("the CONV blend itself is unchanged", () => {
    expect(CONV_WEIGHTS).toEqual({ ret: 0.28, safety: 0.22, tail: 0.18, liquidity: 0.12, volRich: 0.1, touch: 0.1 });
  });
});
