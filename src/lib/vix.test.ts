import { describe, expect, it } from "vitest";
import { iv30d, fearZone } from "./vix";
import type { ExpiryBundle } from "./types";

// Minimal ExpiryBundle factory — only the fields iv30d reads matter.
function ex(optionDte: number, atmIv: number | null, ivEstimated = false): ExpiryBundle {
  return {
    expiry: "", optionExpiry: "", dte: optionDte, optionDte,
    silverFut: null, prevClose: null, oi: null, oiChg: null, atmStrike: null,
    atmIv, ivEstimated, ivRank: null, ivPercentile: null, ivRankEstimated: true,
    expectedMove1sd: null, gex: null, basis: { fairValue: null, basis: null }, chain: [],
  };
}

describe("iv30d — 30-day constant-maturity IV", () => {
  it("interpolates variance between the two expiries bracketing 30 DTE", () => {
    // 6d @ 0.30 and 40d @ 0.40; target 30d sits between.
    const r = iv30d([ex(6, 0.3), ex(40, 0.4)])!;
    expect(r.source).toBe("30d");
    // Variance-time interpolation, not a raw linear IV average.
    const w = (30 - 6) / (40 - 6);
    const varT = ((1 - w) * (0.3 * 0.3 * 6) + w * (0.4 * 0.4 * 40)) / 30;
    expect(r.iv).toBeCloseTo(Math.sqrt(varT), 6);
    expect(r.estimated).toBe(false);
  });

  it("falls back to the nearest expiry when 30d is not bracketed", () => {
    const r = iv30d([ex(6, 0.33)])!;
    expect(r.source).toBe("front");
    expect(r.iv).toBeCloseTo(0.33, 6);
  });

  it("flags estimated when a leg used a proxy", () => {
    const r = iv30d([ex(6, 0.3, false), ex(40, 0.4, true)])!;
    expect(r.estimated).toBe(true);
  });

  it("ignores expiries without a usable IV and returns null when none remain", () => {
    expect(iv30d([ex(30, null), ex(45, 0)])).toBeNull();
    expect(iv30d([])).toBeNull();
    expect(iv30d(null)).toBeNull();
  });
});

describe("fearZone", () => {
  it("maps low percentile to complacency and high to extreme fear", () => {
    expect(fearZone(5).label).toBe("Complacent");
    expect(fearZone(90).label).toBe("Extreme fear");
    expect(fearZone(90).tone).toBe("bear");
  });

  it("defaults a null percentile to the middle band", () => {
    expect(fearZone(null).label).toBe("Normal");
  });
});
