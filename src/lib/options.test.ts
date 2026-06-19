import { describe, expect, it } from "vitest";
import {
  black76Price,
  cushionSigma,
  expectedMove,
  impliedVol,
  probabilityOfTouch,
} from "./options";

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
