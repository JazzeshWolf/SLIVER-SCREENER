import { describe, expect, it } from "vitest";
import { daysTo, isLive, mergeExpiry, retimeSnapshot } from "./expiry";
import type { ExpiryBundle, McxData } from "./types";

function bundle(optionExpiry: string, over: Partial<ExpiryBundle> = {}): ExpiryBundle {
  return {
    expiry: "2026-11-30", optionExpiry, dte: 999, optionDte: 999,
    fut: 250000, prevClose: 249000, oi: 100, oiChg: 0, atmStrike: 250000,
    atmIv: 0.3, ivEstimated: false, ivRank: 50, ivPercentile: 50, ivRankEstimated: false,
    expectedMove1sd: 5000, gex: null, basis: { fairValue: 249000, basis: 1000 },
    chain: [], ...over,
  };
}

function snap(nearest: string, bundles: ExpiryBundle[]): McxData {
  return {
    asOf: "2026-08-21T12:00:00Z", stale: false, partial: false,
    mcx: {
      symbol: "SILVERM", fut: 250000, prevClose: 249000, expiry: "2026-11-30", dte: 999,
      optionExpiry: nearest, optionDte: 999,
      optionExpiries: bundles.map((b) => b.optionExpiry), oi: 100, oiChg: 0,
    },
    options: {
      atmStrike: 250000, atmIv: 0.3, ivRank: 50, ivPercentile: 50, rv20: 0.28,
      expectedMove1sd: 5000, chain: [],
    },
    basis: { fairValue: 249000, basis: 1000 },
    expiries: bundles,
    events: [],
  };
}

const MON = new Date("2026-08-24T10:00:00Z"); // expiry day for the 24 Aug contract

describe("daysTo / isLive — IST contract clock", () => {
  it("counts 0 on expiry day and goes negative after it", () => {
    expect(daysTo("2026-08-24", MON)).toBe(0);
    expect(daysTo("2026-09-24", MON)).toBe(31);
    expect(daysTo("2026-08-21", MON)).toBe(-3);
  });

  it("keeps a contract live through its own expiry day, dead the next", () => {
    expect(isLive("2026-08-24", MON)).toBe(true);
    expect(isLive("2026-08-24", new Date("2026-08-25T02:00:00Z"))).toBe(false);
    expect(isLive(null, MON)).toBe(true); // undated → not our call to hide
  });

  it("rolls on the IST date, not UTC — 23:00 UTC is already tomorrow in Mumbai", () => {
    // 2026-08-24T23:00Z is 2026-08-25 04:30 IST: the 24 Aug contract is done.
    expect(isLive("2026-08-24", new Date("2026-08-24T23:00:00Z"))).toBe(false);
  });
});

describe("retimeSnapshot — the snapshot's day counts are never trusted", () => {
  const bundles = [bundle("2026-08-24"), bundle("2026-09-24"), bundle("2026-10-27")];

  it("recounts DTE from today, ignoring what the server stamped", () => {
    const r = retimeSnapshot(snap("2026-08-24", bundles), MON)!;
    expect(r.mcx.optionDte).toBe(0); // server said 999
    expect(r.expiries!.map((b) => b.optionDte)).toEqual([0, 31, 64]);
  });

  it("drops an expiry once it has passed, even while the snapshot still lists it", () => {
    // The Monday-evening case: the data Action stopped at 18:00 UTC with the
    // 24 Aug contract still nearest; by Tuesday it is history.
    const r = retimeSnapshot(snap("2026-08-24", bundles), new Date("2026-08-25T07:00:00Z"))!;
    expect(r.expiries!.map((b) => b.optionExpiry)).toEqual(["2026-09-24", "2026-10-27"]);
    expect(r.mcx.optionExpiries).toEqual(["2026-09-24", "2026-10-27"]);
  });

  it("re-points the view to the nearest live contract when the default one died", () => {
    const r = retimeSnapshot(snap("2026-08-24", bundles), new Date("2026-08-25T07:00:00Z"))!;
    expect(r.mcx.optionExpiry).toBe("2026-09-24");
    expect(r.mcx.optionDte).toBe(30);
    expect(r.contractsExpired).toBe(false);
  });

  it("flags a snapshot whose every contract has expired instead of hiding it", () => {
    const r = retimeSnapshot(snap("2026-08-24", bundles), new Date("2026-12-01T07:00:00Z"))!;
    expect(r.contractsExpired).toBe(true);
    // Bundles are kept so the cards still say which contract they describe.
    expect(r.expiries).toHaveLength(3);
    expect(r.mcx.optionDte).toBe(0); // clamped, never negative
  });

  it("leaves a snapshot with only live contracts alone apart from the day counts", () => {
    const live = [bundle("2026-09-24"), bundle("2026-10-27")];
    const r = retimeSnapshot(snap("2026-09-24", live), new Date("2026-08-25T07:00:00Z"))!;
    expect(r.mcx.optionExpiry).toBe("2026-09-24");
    expect(r.expiries!.map((b) => b.optionDte)).toEqual([30, 63]);
    expect(r.contractsExpired).toBe(false);
  });

  it("passes null through", () => {
    expect(retimeSnapshot(null, MON)).toBeNull();
  });
});

describe("mergeExpiry", () => {
  it("swaps the chosen bundle's contract data into the view", () => {
    const bundles = [bundle("2026-09-24"), bundle("2026-10-27", { fut: 254390, atmIv: 0.24, optionDte: 63 })];
    const r = mergeExpiry(snap("2026-09-24", bundles), "2026-10-27")!;
    expect(r.mcx.fut).toBe(254390);
    expect(r.mcx.optionDte).toBe(63);
    expect(r.options.atmIv).toBe(0.24);
  });

  it("returns the snapshot untouched for the nearest or an unknown expiry", () => {
    const s = snap("2026-09-24", [bundle("2026-09-24")]);
    expect(mergeExpiry(s, "2026-09-24")).toBe(s);
    expect(mergeExpiry(s, "2027-01-01")).toBe(s);
  });
});
