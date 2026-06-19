import { describe, expect, it } from "vitest";
import {
  clamp,
  correlation,
  normCdf,
  percentRank,
  rangeRank,
  realizedVol,
  vsMovingAverage,
  winsorize,
  zScore,
  zToSignal,
} from "./stats";

describe("stats", () => {
  it("clamps", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it("winsorizes spikes and handles NaN", () => {
    expect(winsorize(9, 2.5)).toBe(2.5);
    expect(winsorize(-9, 2.5)).toBe(-2.5);
    expect(winsorize(NaN)).toBe(0);
  });

  it("z-score returns null without dispersion or sample", () => {
    expect(zScore(5, [3, 3, 3])).toBeNull();
    expect(zScore(5, [1])).toBeNull();
    expect(zScore(2, [0, 2, 4])!).toBeCloseTo(0, 5);
  });

  it("zToSignal saturates at +/-1", () => {
    expect(zToSignal(10)).toBe(1);
    expect(zToSignal(-10)).toBe(-1);
    expect(zToSignal(0)).toBe(0);
  });

  it("correlation: perfect positive and negative", () => {
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])!).toBeCloseTo(1, 6);
    expect(correlation([1, 2, 3, 4], [8, 6, 4, 2])!).toBeCloseTo(-1, 6);
    expect(correlation([1, 2], [1, 2])).toBeNull(); // too short
  });

  it("realized vol is positive for a moving series", () => {
    const v = realizedVol([100, 101, 99, 102, 98, 103]);
    expect(v).toBeGreaterThan(0);
  });

  it("rangeRank and percentRank", () => {
    expect(rangeRank(50, [0, 100])).toBe(50);
    expect(rangeRank(100, [0, 100])).toBe(100);
    expect(percentRank(5, [1, 2, 3, 4, 5])).toBe(100);
  });

  it("vsMovingAverage measures distance from SMA", () => {
    const pts = [10, 10, 10, 10, 20].map((v, i) => ({ t: `d${i}`, v }));
    const r = vsMovingAverage(pts, 5)!;
    expect(r).toBeGreaterThan(0); // latest 20 above the 14 average
  });

  it("normCdf matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 4);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
});
