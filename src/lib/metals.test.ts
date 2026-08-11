// ---------------------------------------------------------------------------
// The metal registry — units, parity and contract resolution.
//
// The lot-multiplier tests here guard the single most dangerous number in the
// app. MCX sells gold in 100 g lots but QUOTES it per 10 g, so ₹/lot is
// premium × 10. Getting that wrong makes every credit, margin and P&L figure
// on the gold screens off by 10×, with nothing anywhere to flag it.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  METALS,
  METAL_IDS,
  allContractSymbols,
  metalFor,
  metalForSymbol,
  parityMult,
  quoteUnitsPerLot,
  strikeStep,
} from "./metals.mjs";
import { fairValue, basis, premiumPct, toIntlPrice } from "./basis";

describe("registry integrity", () => {
  it("exposes exactly the three metals, each self-consistent", () => {
    expect(METAL_IDS).toEqual(["silver", "gold", "copper"]);
    for (const id of METAL_IDS) {
      const m = METALS[id];
      expect(m.id).toBe(id);
      expect(m.contracts.length).toBeGreaterThan(0);
      // The symbol the pipeline pulls must be one this metal actually lists,
      // otherwise lot sizing silently falls back to a different contract.
      expect(m.contracts.map((c) => c.symbol)).toContain(m.feedSymbol);
      expect(m.unitMult).toBeGreaterThan(0);
      expect(m.duty).toBeGreaterThanOrEqual(0);
      expect(m.gst).toBeGreaterThanOrEqual(0);
      expect(m.cotCode).toMatch(/^\d{6}$/);
      expect(m.strikeStepFallback).toBeGreaterThan(0);
    }
  });

  it("has no duplicate contract symbols across metals", () => {
    const all = allContractSymbols();
    expect(new Set(all).size).toBe(all.length);
  });

  it("falls back to silver for an unknown id rather than throwing", () => {
    expect(metalFor("platinum").id).toBe("silver");
    expect(metalFor(null).id).toBe("silver");
    expect(metalFor("GOLD").id).toBe("gold"); // case-insensitive
  });
});

describe("lot multipliers — ₹ per lot", () => {
  // The regression this whole field name exists to prevent.
  it("GOLDM is 10 quote units per lot, NOT 100", () => {
    expect(quoteUnitsPerLot(METALS.gold, "GOLDM")).toBe(10);
  });

  it("gives the right ₹/lot credit for a real premium on each metal", () => {
    // A 2,500 premium on one lot, per metal.
    expect(2500 * quoteUnitsPerLot(METALS.silver, "SILVERM")).toBe(12_500); // 5 kg
    expect(2500 * quoteUnitsPerLot(METALS.silver, "SILVER")).toBe(75_000); // 30 kg
    expect(2500 * quoteUnitsPerLot(METALS.silver, "SILVERMIC")).toBe(2_500); // 1 kg
    expect(2500 * quoteUnitsPerLot(METALS.gold, "GOLDM")).toBe(25_000); // 100 g @ ₹/10g
    expect(2500 * quoteUnitsPerLot(METALS.copper, "COPPER")).toBe(6_250_000); // 2500 kg
  });

  it("falls back to the metal's own feed contract for an unknown symbol", () => {
    // The old normalizeSymbol() sent anything unrecognized to SILVER's 30 kg,
    // which would have mispriced a gold leg 3×.
    expect(quoteUnitsPerLot(METALS.gold, "NONSENSE")).toBe(10);
    expect(quoteUnitsPerLot(METALS.silver, "NONSENSE")).toBe(5);
    expect(quoteUnitsPerLot(METALS.copper, "NONSENSE")).toBe(2500);
  });
});

describe("metalForSymbol", () => {
  it("resolves each registered contract to its own metal", () => {
    expect(metalForSymbol("SILVERM").id).toBe("silver");
    expect(metalForSymbol("SILVERMIC").id).toBe("silver");
    expect(metalForSymbol("GOLDM").id).toBe("gold");
    expect(metalForSymbol("COPPER").id).toBe("copper");
  });

  it("resolves an unlisted family member by longest prefix", () => {
    // GOLDPETAL isn't in the registry, but it is unambiguously gold — and must
    // NOT fall through to silver the way the old default did.
    expect(metalForSymbol("GOLDPETAL").id).toBe("gold");
    expect(metalForSymbol("GOLDGUINEA").id).toBe("gold");
  });
});

describe("import parity", () => {
  it("reproduces the hand-verified silver figure from AUDIT.md G1", () => {
    // XAG 64.96 × 32.1507 oz/kg × INR 94.33 × 1.18 → ~₹232,47x per kg.
    const fv = fairValue(METALS.silver, 64.96, 94.33);
    expect(fv).not.toBeNull();
    expect(fv!).toBeCloseTo(232_471, -1); // within ₹10 of the audited value
  });

  it("prices gold per 10 g, not per ounce or per kg", () => {
    // $4378.2/oz ÷ 31.1035 g/oz × 10 g × 95.44 × 1.18.
    const fv = fairValue(METALS.gold, 4378.2, 95.44)!;
    const byHand = (4378.2 / 31.1035) * 10 * 95.44 * 1.18;
    expect(fv).toBeCloseTo(byHand, 2);
    // Sanity band: a ₹/10g gold quote is ~1.5 lakh at these inputs — three
    // orders of magnitude from the ₹/kg figure a wrong unitMult would give.
    expect(fv).toBeGreaterThan(100_000);
    expect(fv).toBeLessThan(300_000);
  });

  it("converts copper from $/lb to ₹/kg", () => {
    const fv = fairValue(METALS.copper, 5.5, 95.44)!;
    const byHand = 5.5 * 2.20462 * 95.44 * (1 + 0.05 + 0.18);
    expect(fv).toBeCloseTo(byHand, 4);
  });

  it("flags copper's parity as approximate and bullion's as verified", () => {
    // Copper's only free price feed is COMEX while MCX tracks LME, and the US
    // §232 tariff has held them hundreds of dollars a tonne apart — the UI has
    // to be able to say so rather than present a clean-looking basis.
    expect(METALS.copper.parityConfidence).toBe("approximate");
    expect(METALS.silver.parityConfidence).toBe("verified");
    expect(METALS.gold.parityConfidence).toBe("verified");
  });

  it("round-trips MCX price back to the international price", () => {
    for (const id of METAL_IDS) {
      const m = METALS[id];
      const intl = 100;
      const fv = fairValue(m, intl, 90)!;
      expect(toIntlPrice(m, fv, 90)!).toBeCloseTo(intl, 6);
    }
  });

  it("returns null for missing or non-positive inputs instead of guessing", () => {
    expect(fairValue(METALS.silver, null, 94)).toBeNull();
    expect(fairValue(METALS.silver, 64, null)).toBeNull();
    expect(fairValue(METALS.silver, 0, 94)).toBeNull();
    expect(fairValue(METALS.silver, 64, -1)).toBeNull();
  });

  it("computes basis and premium against fair value", () => {
    expect(basis(240_000, 232_471)).toBe(7_529);
    expect(premiumPct(240_000, 200_000)).toBeCloseTo(20, 6);
    expect(basis(null, 1)).toBeNull();
    expect(premiumPct(1, 0)).toBeNull();
  });

  it("keeps silver's parity multiplier at its pre-refactor value", () => {
    // Guards the P1 promise that silver's numbers do not move.
    expect(parityMult(METALS.silver)).toBeCloseTo(32.1507 * 1.18, 10);
  });
});

describe("strikeStep", () => {
  const chainOf = (strikes: number[]) => strikes.map((strike) => ({ strike }));

  it("derives the step from the listed strikes", () => {
    expect(strikeStep(METALS.silver, chainOf([120000, 121000, 122000, 123000]))).toBe(1000);
    expect(strikeStep(METALS.gold, chainOf([130000, 130500, 131000, 131500]))).toBe(500);
  });

  it("uses the median gap, so one missing strike cannot skew it", () => {
    // 122000 absent → one 2000 gap among 1000s.
    expect(strikeStep(METALS.silver, chainOf([120000, 121000, 123000, 124000, 125000]))).toBe(1000);
  });

  it("falls back to the registry value only when the chain is too thin", () => {
    expect(strikeStep(METALS.gold, [])).toBe(METALS.gold.strikeStepFallback);
    expect(strikeStep(METALS.gold, chainOf([130000]))).toBe(METALS.gold.strikeStepFallback);
    expect(strikeStep(METALS.copper, null)).toBe(METALS.copper.strikeStepFallback);
  });

  it("tracks an exchange step change rather than trusting the constant", () => {
    // MCX widened gold's option interval ₹100 → ₹500 on 2026-01-30. A live
    // chain on the OLD step must still be read correctly.
    expect(strikeStep(METALS.gold, chainOf([130000, 130100, 130200, 130300]))).toBe(100);
  });
});
