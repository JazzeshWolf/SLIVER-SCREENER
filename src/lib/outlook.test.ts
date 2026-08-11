// ---------------------------------------------------------------------------
// The Outlook narrative must describe the metal you are actually looking at.
//
// This file exists because the whole tab used to be silver prose regardless of
// contract: a copper screen said "annual supply deficit + solar/EV demand", and
// a gold screen was told it follows gold. Those are the kind of wrong that
// reads as authoritative, so they get a regression test.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildOutlook } from "./outlook";
import { scoreAllHorizons, deriveRegime } from "./scoring";
import { copyFor } from "./copy";
import { METAL_IDS, METALS } from "./metals.mjs";
import type { LiveInputs, McxData, Point } from "./types";

function series(from: number, to: number, n = 300): Point[] {
  return Array.from({ length: n }, (_, i) => ({
    t: `d${i}`,
    v: from + ((to - from) * i) / (n - 1),
  }));
}

const live = (): LiveInputs => ({
  metalUsd: 65,
  xauUsd: 4100,
  usdInr: 95,
  dxy: 119,
  real10y: 2.3,
  breakeven10y: 2.2,
  metalHistory: series(60, 80),
  xauHistory: series(4000, 4400),
  dxyHistory: series(120, 118),
  real10yHistory: series(2.5, 2.2),
  usdInrHistory: series(94, 95),
  asOf: new Date().toISOString(),
  partial: false,
});

const mcxFor = (symbol: string): McxData => ({
  asOf: new Date().toISOString(),
  stale: false,
  partial: false,
  mcx: {
    symbol,
    fut: 90000,
    prevClose: 89000,
    expiry: null,
    dte: 30,
    optionDte: 25,
    oi: 12000,
    oiChg: 500,
  },
  options: {
    atmStrike: 90000,
    atmIv: 0.4,
    ivEstimated: false,
    ivRank: 60,
    ivPercentile: 60,
    rv20: 0.3,
    expectedMove1sd: 4000,
    chain: [],
  },
  basis: { fairValue: 88000, basis: 2000 },
  events: [],
});

function outlookFor(metalId: string) {
  const m = METALS[metalId];
  const l = live();
  const mcx = mcxFor(m.feedSymbol);
  const scores = scoreAllHorizons(l, mcx, metalId);
  const regime = deriveRegime(scores, 25);
  return buildOutlook(l, mcx, scores, regime, null, { premiumPct: 1.2, gsr: 63 });
}

const allText = (metalId: string) =>
  outlookFor(metalId)
    .drivers.map((d) => `${d.category} ${d.note}`)
    .join(" ")
    .toLowerCase();

describe("outlook narrative is per metal", () => {
  it("never tells gold or copper silver's supply story", () => {
    for (const id of ["gold", "copper"]) {
      const t = allText(id);
      expect(t, id).not.toContain("solar");
      expect(t, id).not.toContain("silver institute");
      expect(t, id).not.toContain("slv holdings");
    }
  });

  it("gives copper its own drivers, not bullion's", () => {
    const t = allText("copper");
    expect(t).toContain("copper/gold");
    expect(t).toContain("treatment charges");
    expect(t).toContain("section 232");
    // Copper does not follow gold, and has no gold-silver ratio driver.
    expect(t).not.toContain("gold leadership");
    expect(t).not.toContain("gold-silver ratio");
  });

  it("gives gold central-bank demand and no leadership driver", () => {
    const t = allText("gold");
    expect(t).toContain("official-sector");
    expect(t).not.toContain("gold leadership");
    expect(t).not.toContain("follows with higher beta");
  });

  it("keeps silver's own story intact", () => {
    const t = allText("silver");
    expect(t).toContain("solar");
    expect(t).toContain("gold leadership");
  });

  it("names the right metal in the trend driver for each", () => {
    for (const id of METAL_IDS) {
      const cats = outlookFor(id).drivers.map((d) => d.category);
      expect(cats, id).toContain(copyFor(id).trend.label);
    }
  });

  it("quotes each metal's own import duty, not a hardcoded 15%", () => {
    // Copper is a base metal (5% BCD), not under the bullion regime.
    expect(allText("copper")).toContain("5% duty");
    expect(allText("silver")).toContain("15% duty");
  });

  it("marks the physical/flows driver as not wired rather than inventing one", () => {
    for (const id of METAL_IDS) {
      const flows = outlookFor(id).drivers.find((d) => d.category === copyFor(id).flows.label)!;
      expect(flows, id).toBeDefined();
      expect(flows.live, id).toBe(false);
      expect(flows.note.toLowerCase(), id).toContain("not yet wired live");
    }
  });

  it("produces a bounded net bias for every metal", () => {
    for (const id of METAL_IDS) {
      const o = outlookFor(id);
      expect(o.netBias, id).toBeGreaterThanOrEqual(-10);
      expect(o.netBias, id).toBeLessThanOrEqual(10);
      expect(o.drivers.length, id).toBeGreaterThanOrEqual(6);
    }
  });
});
