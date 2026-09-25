import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SELL_TOP_N, mergeExpiry, sellView, shortlist } from "./sellView";
import type { McxData, SellCandidate, SellScreen } from "./types";

const cand = (strike: number, type: "CE" | "PE", conv: number, ok = true) =>
  ({ strike, type, conv, ok, reasons: ok ? [] : ["thinOI"] }) as unknown as SellCandidate;

describe("shortlist (the Sell tab's list, shared with the Telegram alerts)", () => {
  it("keeps survivors of one side only, best first, capped at SELL_TOP_N", () => {
    const candidates = [
      cand(1, "CE", 99, false),
      ...Array.from({ length: 12 }, (_, i) => cand(100 + i, "CE", 90 - i)),
      cand(50, "PE", 95),
    ];
    const rows = shortlist({ candidates } as SellScreen, "CE");
    expect(rows).toHaveLength(SELL_TOP_N);
    expect(rows.every((c) => c.ok && c.type === "CE")).toBe(true);
    expect(rows[0].conv).toBe(90);
  });
});

describe("sellView over a real snapshot", () => {
  const { live, ...mcx } = JSON.parse(readFileSync("public/data/silver.json", "utf8"));

  it("scores one view per listed expiry, the nearest being the base snapshot", () => {
    const v = sellView(live, mcx as McxData, undefined, new Date(mcx.asOf));
    expect(v.expiries.map((e) => e.optionExpiry)).toEqual((mcx.expiries ?? []).map((e: { optionExpiry: string }) => e.optionExpiry));
    expect(mergeExpiry(mcx, mcx.mcx.optionExpiry)).toBe(mcx);
    for (const e of v.expiries) {
      expect(e.shown.PE.length).toBeLessThanOrEqual(SELL_TOP_N);
      expect(e.shown.CE.every((c) => c.ok)).toBe(true);
    }
  });
});
