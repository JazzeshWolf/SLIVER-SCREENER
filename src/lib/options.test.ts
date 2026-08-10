import { describe, expect, it } from "vitest";
import {
  black76Delta,
  black76Price,
  cushionSigma,
  cvarShort,
  expectedMove,
  fairValueUnder,
  impliedVol,
  lognormalMeasure,
  measureMean,
  normInv,
  probOtm,
  probabilityAbove,
  probabilityOfTouch,
  spanScanMargin,
} from "./options";
import { normCdf } from "./stats";

describe("Black-76 options math", () => {
  it("recovers implied vol from a priced option (round-trip)", () => {
    const F = 90000;
    const K = 92000;
    const t = 30 / 365;
    const vol = 0.35;
    const price = black76Price(F, K, t, vol, "CE");
    const iv = impliedVol(price, F, K, t, "CE")!;
    expect(iv).toBeCloseTo(vol, 3);
  });

  it("round-trips a put too", () => {
    const F = 90000;
    const K = 88000;
    const t = 21 / 365;
    const vol = 0.42;
    const price = black76Price(F, K, t, vol, "PE");
    const iv = impliedVol(price, F, K, t, "PE")!;
    expect(iv).toBeCloseTo(vol, 3);
  });

  it("returns null for sub-intrinsic price", () => {
    const F = 90000;
    const K = 80000;
    const t = 30 / 365;
    expect(impliedVol(100, F, K, t, "CE")).toBeNull(); // intrinsic ~10000 > 100
  });

  it("expected move scales with vol and sqrt(time)", () => {
    const em1 = expectedMove(90000, 0.3, 30 / 365);
    const em2 = expectedMove(90000, 0.6, 30 / 365);
    expect(em2).toBeCloseTo(em1 * 2, 3);
  });

  it("probability of touch exceeds prob of finishing ITM and is bounded", () => {
    const p = probabilityOfTouch(90000, 95000, 0.4, 30 / 365);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("cushion in sigma grows as strike moves away", () => {
    const near = cushionSigma(90000, 92000, 0.4, 30 / 365);
    const far = cushionSigma(90000, 99000, 0.4, 30 / 365);
    expect(far).toBeGreaterThan(near);
  });
});

describe("Black-76 delta", () => {
  const F = 90000;
  const t = 30 / 365;
  const vol = 0.4;

  it("is ~0.5 ATM, bounded, and put = call − 1 (put-call parity)", () => {
    expect(black76Delta(F, F, t, vol, "CE")).toBeCloseTo(0.52, 1);
    const c = black76Delta(F, 95000, t, vol, "CE");
    const p = black76Delta(F, 95000, t, vol, "PE");
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(1);
    expect(p).toBeCloseTo(c - 1, 10);
  });

  it("matches a finite-difference of the price", () => {
    const h = 1;
    const fd = (black76Price(F + h, 95000, t, vol, "CE") - black76Price(F - h, 95000, t, vol, "CE")) / (2 * h);
    // 5 decimals: normCdf is an Abramowitz & Stegun approximation, not exact.
    expect(black76Delta(F, 95000, t, vol, "CE")).toBeCloseTo(fd, 5);
  });

  it("collapses to the intrinsic slope at expiry", () => {
    expect(black76Delta(F, 85000, 0, vol, "CE")).toBe(1);
    expect(black76Delta(F, 95000, 0, vol, "CE")).toBe(0);
    expect(black76Delta(F, 95000, 0, vol, "PE")).toBe(-1);
  });
});

describe("forecast measure", () => {
  const F = 235900;
  const t = 14 / 365;
  const vol = 0.3;

  it("zero drift reproduces the risk-neutral probabilities", () => {
    const ms = lognormalMeasure(F, vol, t, 0)!;
    expect(measureMean(ms)).toBeCloseTo(F, 6); // martingale
    expect(probOtm(250000, "CE", ms)).toBeCloseTo(1 - probabilityAbove(F, 250000, vol, t), 6);
    expect(fairValueUnder(250000, "CE", ms)).toBeCloseTo(black76Price(F, 250000, t, vol, "CE"), 4);
  });

  it("a positive drift makes calls riskier and puts safer to sell", () => {
    const flat = lognormalMeasure(F, vol, t, 0)!;
    const bull = lognormalMeasure(F, vol, t, 0.15)!;
    expect(probOtm(250000, "CE", bull)).toBeLessThan(probOtm(250000, "CE", flat));
    expect(probOtm(215000, "PE", bull)).toBeGreaterThan(probOtm(215000, "PE", flat));
  });

  it("normInv inverts the normal CDF", () => {
    for (const p of [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]) {
      expect(normCdf(normInv(p))).toBeCloseTo(p, 6);
    }
  });
});

describe("CVaR of a short option", () => {
  const F = 235900;
  const t = 14 / 365;
  const ms = lognormalMeasure(F, 0.3, t, 0)!;

  /** Independent check: average the worst 5% of a deterministic quantile grid. */
  function cvarByQuantiles(K: number, type: "CE" | "PE", premium: number): number {
    const n = 200000;
    const losses: number[] = [];
    for (let i = 1; i <= n; i++) {
      const q = (i - 0.5) / n;
      const inTail = type === "CE" ? q > 0.95 : q < 0.05;
      if (!inTail) continue;
      const S = Math.exp(ms.m + ms.sd * normInv(q));
      losses.push((type === "CE" ? Math.max(S - K, 0) : Math.max(K - S, 0)) - premium);
    }
    return losses.reduce((a, b) => a + b, 0) / losses.length;
  }

  it("matches a numerical tail average for a short call", () => {
    expect(cvarShort(250000, "CE", 2329.5, ms)).toBeCloseTo(cvarByQuantiles(250000, "CE", 2329.5), 0);
  });

  it("matches a numerical tail average for a short put", () => {
    expect(cvarShort(215000, "PE", 974, ms)).toBeCloseTo(cvarByQuantiles(215000, "PE", 974), 0);
  });

  it("handles a strike beyond the tail barrier (the whole tail is OTM)", () => {
    // 190000 sits below the 5th percentile, so the tail average is the full
    // expected payoff. Premium 0 keeps the no-loss clamp from binding.
    expect(cvarShort(190000, "PE", 0, ms)).toBeCloseTo(cvarByQuantiles(190000, "PE", 0), 0);
  });

  it("clamps at zero when the premium covers even the tail", () => {
    expect(cvarByQuantiles(190000, "PE", 100)).toBeLessThan(0); // tail still profitable
    expect(cvarShort(190000, "PE", 100, ms)).toBe(0); // reported as no tail risk
    expect(cvarShort(400000, "CE", 5, ms)).toBe(0);
  });

  it("shrinks as the strike moves away", () => {
    expect(cvarShort(260000, "CE", 1133.5, ms)).toBeLessThan(cvarShort(240000, "CE", 5035, ms));
  });
});

describe("SPAN-like margin estimate", () => {
  const F = 235900;
  const t = 14 / 365;

  it("needs more capital near the money than far out", () => {
    const atm = spanScanMargin(F, 236000, t, 0.37, "CE");
    const otm = spanScanMargin(F, 260000, t, 0.42, "CE");
    expect(atm).toBeGreaterThan(otm);
  });

  it("lands in a plausible ₹/kg range for MCX silver", () => {
    const atm = spanScanMargin(F, 236000, t, 0.37, "CE");
    expect(atm).toBeGreaterThan(0.05 * F); // more than 5% of the futures price
    expect(atm).toBeLessThan(0.12 * F); // and less than 12%
  });

  it("never falls below the short-option minimum floor", () => {
    expect(spanScanMargin(F, 400000, t, 0.4, "CE")).toBeGreaterThanOrEqual(0.005 * F);
  });

  it("grows with the scan range", () => {
    const tight = spanScanMargin(F, 250000, t, 0.39, "CE", { priceScan: 0.03 });
    const wide = spanScanMargin(F, 250000, t, 0.39, "CE", { priceScan: 0.1 });
    expect(wide).toBeGreaterThan(tight);
  });
});
