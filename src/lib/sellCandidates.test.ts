import { describe, expect, it } from "vitest";
import { buildForecast, fitSmile, screenSellCandidates } from "./sellCandidates";
import type { McxData, OptionQuote, RegimeResult } from "./types";

// Fixture: a real MCX SILVERM chain (2026-08-10 snapshot, F = 235,900, 14 DTE,
// ATM IV 36.9%, RV20 26.1%), trimmed to both wings and deliberately including
// the three stale prints that a naive edge sort puts at the top of the list:
//   247000 CE — OI 1,  IV 52.2%  (fake ~24% edge)
//   257000 CE — OI 2,  IV 46.7%  (fake ~19% edge)
//   251000 CE — OI 3,  IV 29.6%  (fake NEGATIVE edge)
const CHAIN: OptionQuote[] = [
  { strike: 211000, type: "PE", ltp: 456.5, iv: 0.378, oi: 28, oiChg: 0 },
  { strike: 213000, type: "PE", ltp: 815, iv: 0.407, oi: 70, oiChg: -3 },
  { strike: 215000, type: "PE", ltp: 974, iv: 0.398, oi: 1796, oiChg: -15 },
  { strike: 218000, type: "PE", ltp: 1290, iv: 0.387, oi: 208, oiChg: 65 },
  { strike: 220000, type: "PE", ltp: 1600, iv: 0.385, oi: 3656, oiChg: -101 },
  { strike: 225000, type: "PE", ltp: 2572.5, iv: 0.373, oi: 1845, oiChg: 29 },
  { strike: 230000, type: "PE", ltp: 4071.5, iv: 0.366, oi: 2191, oiChg: 184 },
  { strike: 235000, type: "PE", ltp: 6275, iv: 0.368, oi: 1057, oiChg: 225 },
  { strike: 240000, type: "CE", ltp: 5035, iv: 0.374, oi: 4773, oiChg: 287 },
  { strike: 245000, type: "CE", ltp: 3421, iv: 0.379, oi: 1575, oiChg: 68 },
  { strike: 247000, type: "CE", ltp: 5189, iv: 0.522, oi: 1, oiChg: 0 },
  { strike: 250000, type: "CE", ltp: 2329.5, iv: 0.389, oi: 3422, oiChg: 246 },
  { strike: 251000, type: "CE", ltp: 995.5, iv: 0.296, oi: 3, oiChg: 0 },
  { strike: 255000, type: "CE", ltp: 1624.5, iv: 0.404, oi: 755, oiChg: -91 },
  { strike: 257000, type: "CE", ltp: 2060, iv: 0.467, oi: 2, oiChg: 0 },
  { strike: 260000, type: "CE", ltp: 1133.5, iv: 0.419, oi: 2707, oiChg: null },
];

function mcxFixture(over: Partial<McxData> = {}): McxData {
  return {
    asOf: "2026-08-10T06:04:29.830Z",
    stale: false,
    partial: false,
    mcx: {
      symbol: "SILVERM",
      silverFut: 235900,
      prevClose: 227510,
      expiry: "2026-08-31",
      dte: 21,
      optionExpiry: "2026-08-24",
      optionDte: 14,
      oi: 82411,
      oiChg: -9304,
    },
    options: {
      atmStrike: 236000,
      atmIv: 0.369,
      ivEstimated: false,
      ivRank: 64.4,
      ivPercentile: 57.7,
      ivRankEstimated: false,
      rv20: 0.2606,
      expectedMove1sd: 17048,
      chain: CHAIN,
    },
    basis: { fairValue: 232237, basis: 3663 },
    events: [],
    ...over,
  };
}

const regime = (over: Partial<RegimeResult> = {}): RegimeResult => ({
  regime: "chop",
  label: "Chop / range",
  structure: "Sell strangle (both sides)",
  dteHorizon: "1M",
  directionalLeanAllowed: false,
  ...over,
});

const byStrike = <T extends { strike: number; type: string }>(rows: T[], strike: number, type: string): T =>
  rows.find((x) => x.strike === strike && x.type === type)!;

describe("fitSmile", () => {
  it("fits the OTM smile and ignores legs too quiet to be trusted", () => {
    const fit = fitSmile(CHAIN, 235900)!;
    expect(fit).not.toBeNull();
    expect(fit.n).toBe(13); // the three OI<25 stale prints never define the smile
    // Fitted IV near the money sits close to the quoted ATM IV.
    expect(fit.at(0)).toBeGreaterThan(0.34);
    expect(fit.at(0)).toBeLessThan(0.4);
  });

  it("returns null rather than fabricating a fit on a thin chain", () => {
    expect(fitSmile(CHAIN.slice(0, 3), 235900)).toBeNull();
    expect(fitSmile(CHAIN, 0)).toBeNull();
  });
});

describe("buildForecast", () => {
  it("blends forecast vol below IV, toward realized", () => {
    const f = buildForecast(mcxFixture(), 0)!;
    expect(f.vol).toBeCloseTo(0.6 * 0.2606 + 0.4 * 0.369, 6);
    expect(f.vol).toBeLessThan(0.369); // below IV — that gap is the edge
    expect(f.vol).toBeGreaterThan(0.2606);
    expect(f.drift).toBe(0);
  });

  it("caps drift at half a sigma even on a maxed-out direction score", () => {
    const f = buildForecast(mcxFixture(), 10)!;
    expect(f.drift).toBeCloseTo(0.5 * f.vol, 10);
    const clamped = buildForecast(mcxFixture(), 99)!;
    expect(clamped.drift).toBeCloseTo(f.drift, 10);
  });

  it("returns null when the contract can't support a forecast", () => {
    expect(buildForecast(mcxFixture({ mcx: { ...mcxFixture().mcx, silverFut: null } }), 0)).toBeNull();
    expect(
      buildForecast(
        mcxFixture({ options: { ...mcxFixture().options, atmIv: null, rv20: null } }),
        0,
      ),
    ).toBeNull();
  });
});

describe("screenSellCandidates — filters", () => {
  const res = screenSellCandidates(mcxFixture(), { score: 0, regime: regime() });

  it("rejects the stale prints that a pure-edge sort would rank first", () => {
    for (const k of [247000, 251000, 257000]) {
      const row = byStrike(res.candidates, k, "CE");
      expect(row.ok).toBe(false);
      expect(row.reasons).toContain("offSmile");
      expect(row.reasons).toContain("thinOI");
    }
  });

  it("rejects strikes inside the gamma zone", () => {
    expect(byStrike(res.candidates, 240000, "CE").reasons).toContain("tooClose");
    expect(byStrike(res.candidates, 235000, "PE").reasons).toContain("tooClose");
  });

  it("keeps thin-but-real strikes, flagged rather than deleted", () => {
    const k211 = byStrike(res.candidates, 211000, "PE");
    expect(k211.ok).toBe(true); // OI 28 clears the floor of 25
    expect(k211.thin).toBe(true);
  });

  it("never includes ITM legs", () => {
    expect(res.candidates.every((c) => (c.type === "CE" ? c.strike > 235900 : c.strike < 235900))).toBe(true);
  });
});

describe("screenSellCandidates — ranking", () => {
  const res = screenSellCandidates(mcxFixture(), { score: 0, regime: regime() });
  const top = (type: "CE" | "PE") => res.candidates.filter((c) => c.ok && c.type === type)[0];

  it("picks the balanced strikes on the real chain", () => {
    expect(top("PE").strike).toBe(215000);
    expect(top("CE").strike).toBe(260000);
  });

  it("reproduces the columns for the top put", () => {
    const c = top("PE");
    expect(c.pOtm).toBeCloseTo(0.937, 2);
    expect(c.credit).toBe(974 * 5); // SILVERM lot = 5 kg
    expect(c.cushion).toBeCloseTo(1.14, 1);
    expect(c.delta).toBeLessThan(0); // long-put convention
    expect(c.delta).toBeGreaterThan(-0.15);
    expect(c.breakeven).toBe(215000 - 974);
    expect(c.edge).toBeGreaterThan(0);
  });

  it("is NOT monotone in distance — CONV peaks in the middle, which is the point", () => {
    const puts = res.candidates.filter((c) => c.type === "PE").sort((a, b) => a.strike - b.strike);
    const best = puts.reduce((b, c) => (c.conv > b.conv ? c : b), puts[0]);
    expect(best.strike).toBeGreaterThan(puts[0].strike); // not the furthest
    expect(best.strike).toBeLessThan(puts[puts.length - 1].strike); // not the closest
  });

  it("prices safety and return against each other: further out is safer but earns less", () => {
    const near = byStrike(res.candidates, 230000, "PE");
    const far = byStrike(res.candidates, 211000, "PE");
    expect(far.pOtm).toBeGreaterThan(near.pOtm);
    expect(far.credit).toBeLessThan(near.credit);
    expect(far.tailPct).toBeLessThan(near.tailPct);
  });

  it("uses a forecast P(OTM) that is distinct from 1−|delta|", () => {
    const c = byStrike(res.candidates, 215000, "PE");
    expect(Math.abs(c.pOtm - (1 - Math.abs(c.delta)))).toBeGreaterThan(0.02);
  });

  it("needs less margin the further out the strike is", () => {
    expect(byStrike(res.candidates, 240000, "CE").margin)
      .toBeGreaterThan(byStrike(res.candidates, 260000, "CE").margin);
  });
});

describe("screenSellCandidates — direction and regime", () => {
  it("a bullish drift makes puts safer and calls riskier", () => {
    const flat = screenSellCandidates(mcxFixture(), { score: 0, regime: regime() });
    const bull = screenSellCandidates(mcxFixture(), { score: 8, regime: regime() });
    expect(byStrike(bull.candidates, 215000, "PE").pOtm)
      .toBeGreaterThan(byStrike(flat.candidates, 215000, "PE").pOtm);
    expect(byStrike(bull.candidates, 260000, "CE").pOtm)
      .toBeLessThan(byStrike(flat.candidates, 260000, "CE").pOtm);
  });

  it("tilts toward the regime's side only when the lean is allowed", () => {
    const opts = { score: 6 };
    const neutral = screenSellCandidates(mcxFixture(), { ...opts, regime: regime() });
    const trend = screenSellCandidates(mcxFixture(), {
      ...opts,
      regime: regime({ regime: "trend_up", directionalLeanAllowed: true }),
    });
    expect(byStrike(trend.candidates, 215000, "PE").withRegime).toBe(true);
    expect(byStrike(trend.candidates, 260000, "CE").withRegime).toBe(false);
    expect(byStrike(neutral.candidates, 215000, "PE").withRegime).toBeNull();
    expect(byStrike(trend.candidates, 215000, "PE").conv)
      .toBeGreaterThan(byStrike(neutral.candidates, 215000, "PE").conv);
  });
});

describe("screenSellCandidates — honesty and degradation", () => {
  it("shrinks every score when IV is a realized-vol proxy", () => {
    const real = screenSellCandidates(mcxFixture(), { score: 0 });
    const proxy = screenSellCandidates(
      mcxFixture({ options: { ...mcxFixture().options, ivEstimated: true } }),
      { score: 0 },
    );
    expect(proxy.confidence).toBeLessThan(real.confidence);
    expect(byStrike(proxy.candidates, 215000, "PE").conv)
      .toBeLessThan(byStrike(real.candidates, 215000, "PE").conv);
  });

  it("shrinks on a stale snapshot", () => {
    const stale = screenSellCandidates(mcxFixture({ stale: true }), { score: 0 });
    expect(stale.confidence).toBeLessThan(1);
  });

  it("sizes credit and margin off the contract's lot", () => {
    const big = screenSellCandidates(
      mcxFixture({ mcx: { ...mcxFixture().mcx, symbol: "SILVER" } }),
      { score: 0 },
    );
    expect(big.lotKg).toBe(30);
    expect(byStrike(big.candidates, 215000, "PE").credit).toBe(974 * 30);
  });

  it("honours a real broker margin over the model", () => {
    const res = screenSellCandidates(mcxFixture(), { score: 0, marginOverridePerLot: 42000 });
    const c = byStrike(res.candidates, 215000, "PE");
    expect(c.marginPerLot).toBe(42000);
    expect(c.marginModelled).toBe(false);
  });

  it("returns an empty screen instead of throwing on missing data", () => {
    const empty = screenSellCandidates(
      mcxFixture({ options: { ...mcxFixture().options, chain: [] } }),
      {},
    );
    expect(empty.candidates).toEqual([]);
    const noFut = screenSellCandidates(
      mcxFixture({ mcx: { ...mcxFixture().mcx, silverFut: null } }),
      {},
    );
    expect(noFut.candidates).toEqual([]);
  });

  it("still ranks when no leg has a solvable IV (falls back to ATM IV)", () => {
    const noIv = screenSellCandidates(
      mcxFixture({
        options: {
          ...mcxFixture().options,
          chain: CHAIN.map((o) => ({ ...o, iv: null })),
        },
      }),
      { score: 0 },
    );
    expect(noIv.smileFitted).toBe(false);
    expect(noIv.candidates.length).toBe(CHAIN.length);
    expect(noIv.candidates.every((c) => c.reasons.includes("noIV"))).toBe(true);
  });
});
