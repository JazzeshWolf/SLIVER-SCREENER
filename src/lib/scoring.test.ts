import { describe, expect, it } from "vitest";
import type { HorizonScore, LiveInputs, McxData, Point } from "./types";
import {
  deriveRegime,
  premiumSellScore,
  scoreAllHorizons,
  scoreHorizon,
  thetaZone,
} from "./scoring";

// --- fixture builders ------------------------------------------------------

/** Series that is flat at `base` then jumps to `end` on the last point, so
 *  momentum (latest vs moving average) reads strongly directional. */
function momentum(base: number, end: number, n = 60): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < n - 1; i++) out.push({ t: `d${i}`, v: base });
  out.push({ t: `d${n - 1}`, v: end });
  return out;
}

function emptyLive(over: Partial<LiveInputs> = {}): LiveInputs {
  return {
    xagUsd: 65,
    xauUsd: 4100,
    usdInr: 86,
    dxy: 97,
    real10y: 1.5,
    breakeven10y: 2.3,
    xagHistory: [],
    xauHistory: [],
    dxyHistory: [],
    real10yHistory: [],
    usdInrHistory: [],
    asOf: new Date().toISOString(),
    partial: false,
    ...over,
  };
}

function mcxFixture(over: Partial<McxData["mcx"]> = {}): McxData {
  return {
    asOf: new Date().toISOString(),
    stale: false,
    partial: false,
    mcx: { symbol: "SILVER", silverFut: 90000, prevClose: 89000, expiry: null, dte: 30, oi: 12000, oiChg: 1000, ...over },
    options: { atmStrike: 90000, atmIv: 0.4, ivRank: 70, ivPercentile: 65, rv20: 0.3, expectedMove1sd: 4000, chain: [] },
    basis: { fairValue: 88000, basis: 2000 },
    events: [],
  };
}

function makeHS(horizon: HorizonScore["horizon"], score: number): HorizonScore {
  return {
    horizon,
    score,
    rawScore: score,
    confidence: 1,
    bucket: score >= 3 ? "bullish" : score <= -3 ? "bearish" : "neutral",
    factors: [],
    partial: false,
  };
}

// --- tests -----------------------------------------------------------------

describe("scoreHorizon", () => {
  it("reads bullish when momentum + positioning + deficit bias all point up", () => {
    const live = emptyLive({
      xagHistory: momentum(60, 80),
      xauHistory: momentum(4000, 4400),
    });
    const hs = scoreHorizon("1M", live, mcxFixture());
    expect(hs.bucket).toBe("bullish");
    expect(hs.score).toBeGreaterThan(3);
  });

  it("reads bearish when momentum points down (on 1D, where structural bias is off)", () => {
    // On 1D the standing bullish deficit-bias weight is 0, so price action dominates.
    const live = emptyLive({
      xagHistory: momentum(80, 60),
      xauHistory: momentum(4400, 4000),
    });
    const hs = scoreHorizon("1D", live, mcxFixture({ silverFut: 87000, prevClose: 90000, oiChg: 1000 }));
    expect(hs.bucket).toBe("bearish");
    expect(hs.score).toBeLessThan(-3);
  });

  it("structural deficit bias cushions bearish momentum on the 1M horizon", () => {
    const bear = emptyLive({ xagHistory: momentum(80, 60), xauHistory: momentum(4400, 4000) });
    const bull = emptyLive({ xagHistory: momentum(60, 80), xauHistory: momentum(4000, 4400) });
    const bearScore = scoreHorizon("1M", bear, mcxFixture({ silverFut: 89000, prevClose: 90000 })).score;
    const bullScore = scoreHorizon("1M", bull, mcxFixture()).score;
    expect(bearScore).toBeLessThan(bullScore);
    expect(bearScore).toBeLessThan(0); // still net bearish, just dampened
  });

  it("redistributes weight across present factors and zeroes the missing ones", () => {
    // Only momentum + positioning + deficit bias are available (no FX/yield history).
    const live = emptyLive({ xagHistory: momentum(60, 80), xauHistory: momentum(4000, 4400) });
    const hs = scoreHorizon("1M", live, mcxFixture());
    const present = hs.factors.filter((f) => f.present);
    const missing = hs.factors.filter((f) => !f.present);
    const sum = present.reduce((a, f) => a + f.weight, 0);
    expect(sum).toBeCloseTo(1, 6); // effective weights renormalize to 1
    expect(missing.every((f) => f.weight === 0)).toBe(true);
  });

  it("confidence-gates: stale data shrinks the score toward zero", () => {
    const live = emptyLive({ xagHistory: momentum(60, 80), xauHistory: momentum(4000, 4400) });
    const fresh = scoreHorizon("1M", live, mcxFixture());
    const stale = scoreHorizon("1M", live, { ...mcxFixture(), stale: true });
    expect(stale.confidence).toBeLessThan(fresh.confidence);
    expect(Math.abs(stale.score)).toBeLessThan(Math.abs(fresh.score));
  });

  it("never lets |score| exceed |rawScore| (confidence in [0,1])", () => {
    const live = emptyLive({ xagHistory: momentum(60, 80), xauHistory: momentum(4000, 4400) });
    const all = scoreAllHorizons(live, mcxFixture());
    for (const h of Object.values(all)) {
      expect(Math.abs(h.score)).toBeLessThanOrEqual(Math.abs(h.rawScore) + 1e-9);
      expect(h.confidence).toBeGreaterThanOrEqual(0);
      expect(h.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("gives zero score and confidence when no factors are available", () => {
    const hs = scoreHorizon("1D", emptyLive(), {
      ...mcxFixture(),
      mcx: { symbol: "S", silverFut: null, prevClose: null, expiry: null, dte: null, oi: null, oiChg: null },
    });
    expect(hs.score).toBe(0);
    expect(hs.confidence).toBe(0);
  });
});

describe("deriveRegime", () => {
  it("calls trend_up when 1W and 1M both clearly bullish", () => {
    const r = deriveRegime({ "1D": makeHS("1D", 2), "1W": makeHS("1W", 4), "1M": makeHS("1M", 5) }, 30);
    expect(r.regime).toBe("trend_up");
    expect(r.directionalLeanAllowed).toBe(true);
  });

  it("calls trend_down when both clearly bearish", () => {
    const r = deriveRegime({ "1D": makeHS("1D", -2), "1W": makeHS("1W", -4), "1M": makeHS("1M", -5) }, 30);
    expect(r.regime).toBe("trend_down");
  });

  it("calls chop when horizons disagree in sign", () => {
    const r = deriveRegime({ "1D": makeHS("1D", -2), "1W": makeHS("1W", -4), "1M": makeHS("1M", 5) }, 30);
    expect(r.regime).toBe("chop");
    expect(r.directionalLeanAllowed).toBe(false);
  });

  it("calls no_conviction when both horizons lean the same way but weakly", () => {
    const r = deriveRegime({ "1D": makeHS("1D", 1), "1W": makeHS("1W", 1), "1M": makeHS("1M", 2) }, 30);
    expect(r.regime).toBe("no_conviction");
    expect(r.directionalLeanAllowed).toBe(false);
  });

  it("uses the 1W horizon as decision horizon for short-dated options", () => {
    const r = deriveRegime({ "1D": makeHS("1D", 0), "1W": makeHS("1W", 4), "1M": makeHS("1M", 4) }, 5);
    expect(r.dteHorizon).toBe("1W");
  });

  it("hysteresis keeps an established uptrend if the decision horizon is still firm", () => {
    // 1M dipped just below threshold but decision horizon (1M) still firm at 2.5
    const scores = { "1D": makeHS("1D", 1), "1W": makeHS("1W", 2), "1M": makeHS("1M", 2.5) };
    const r = deriveRegime(scores, 30, "trend_up");
    expect(r.regime).toBe("trend_up");
  });
});

describe("premiumSellScore", () => {
  it("is green when IV rich, theta favorable, no event", () => {
    const p = premiumSellScore(mcxFixture(), [], new Date("2026-06-19"));
    expect(p.band).toBe("green");
    expect(p.score).toBeGreaterThanOrEqual(65);
  });

  it("drops to red when IV is low", () => {
    const m = mcxFixture();
    m.options.ivRank = 10;
    m.options.atmIv = 0.18;
    m.options.rv20 = 0.3;
    const p = premiumSellScore(m, [], new Date("2026-06-19"));
    expect(p.band).toBe("red");
  });

  it("event within 3 sessions zeroes the event-clear component", () => {
    const m = mcxFixture();
    const p = premiumSellScore(m, [{ date: "2026-06-20" }], new Date("2026-06-19"));
    expect(p.components.eventClear).toBe(0);
  });

  it("theta zone peaks in the 20-40 DTE sweet spot and is low near expiry", () => {
    expect(thetaZone(30)!).toBeGreaterThan(thetaZone(3)!);
    expect(thetaZone(30)!).toBeGreaterThan(thetaZone(80)!);
    expect(thetaZone(5)!).toBeLessThan(0.5);
  });
});
