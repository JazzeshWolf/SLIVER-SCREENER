import { describe, expect, it } from "vitest";
import type { LiveInputs, Point } from "./types";
import { walkForwardHitRate } from "./track";

function series(n: number, fn: (i: number) => number): Point[] {
  const out: Point[] = [];
  const base = new Date("2026-01-01T00:00:00Z").getTime();
  for (let i = 0; i < n; i++) {
    out.push({ t: new Date(base + i * 86400000).toISOString().slice(0, 10), v: fn(i) });
  }
  return out;
}

function liveFixture(n = 220): LiveInputs {
  // Drifting-up silver with realistic wobble; supportive macro backdrop.
  const noise = (i: number) => Math.sin(i * 0.7) * 1.2 + Math.sin(i * 0.23) * 2.1;
  return {
    xagUsd: 70,
    xauUsd: 4300,
    usdInr: 88,
    dxy: 100,
    real10y: 1.5,
    breakeven10y: 2.3,
    xagHistory: series(n, (i) => 60 + i * 0.08 + noise(i)),
    xauHistory: series(n, (i) => 4000 + i * 2 + noise(i) * 8),
    dxyHistory: series(n, (i) => 106 - i * 0.03 + Math.sin(i * 0.5) * 0.4),
    real10yHistory: series(n, (i) => 2.4 - i * 0.004 + Math.sin(i * 0.4) * 0.05),
    usdInrHistory: series(n, (i) => 86 + i * 0.01 + Math.sin(i * 0.6) * 0.15),
    asOf: new Date().toISOString(),
    partial: false,
  };
}

describe("walkForwardHitRate", () => {
  it("returns null when history is too short to check anything", () => {
    const live = liveFixture(80);
    expect(walkForwardHitRate(live)).toBeNull();
  });

  it("produces bounded, coherent stats on a realistic sample", () => {
    const res = walkForwardHitRate(liveFixture());
    expect(res).not.toBeNull();
    for (const hr of [res!.w1, res!.m1]) {
      expect(hr.n).toBeGreaterThanOrEqual(0);
      expect(hr.hits).toBeGreaterThanOrEqual(0);
      expect(hr.hits).toBeLessThanOrEqual(hr.n);
      expect(hr.rate).toBeGreaterThanOrEqual(0);
      expect(hr.rate).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic for the same inputs", () => {
    const a = walkForwardHitRate(liveFixture());
    const b = walkForwardHitRate(liveFixture());
    expect(a).toEqual(b);
  });
});
