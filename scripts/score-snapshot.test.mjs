import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SCHEMA, scoreAll } from "./score-snapshot.mjs";
import { sellView, shortlist } from "../src/lib/sellView.ts";

const load = (id) => JSON.parse(readFileSync(`public/data/${id}.json`, "utf8"));
const snaps = { silver: load("silver"), gold: load("gold"), copper: load("copper") };

// The EOD archive (sliver-screener-eod-archive) stores this output forever and
// normalises it into its database. These tests pin the fields it reads.
describe("score-snapshot (the EOD archive's contract)", () => {
  const doc = scoreAll(sellView, snaps);

  it("scores every metal and carries the schema version", () => {
    expect(doc.schema).toBe(SCHEMA);
    expect(Object.keys(doc.metals)).toEqual(["silver", "gold", "copper"]);
  });

  it("covers every expiry with the fields the archive normalises", () => {
    for (const m of Object.values(doc.metals)) {
      expect(m.regime.regime).toMatch(/trend_up|trend_down|chop|no_conviction/);
      for (const e of m.expiries) {
        expect(e.optionExpiry).toMatch(/^\d{4}-\d\d-\d\d$/);
        expect(e.futExpiry).toMatch(/^\d{4}-\d\d-\d\d$/);
        expect(e.gates).toHaveProperty("vrpBlocked");
        for (const c of e.candidates) {
          for (const k of ["strike", "type", "conv", "ok", "displayed", "premium", "pOtm", "touch", "cushion", "delta", "edgePct", "romAnnual", "marginPerLot", "sub"])
            expect(c).toHaveProperty(k);
        }
      }
    }
  });

  it("marks exactly the Sell tab's list as displayed", () => {
    const { live, ...mcx } = snaps.silver;
    const v = sellView(live, mcx, undefined, new Date(snaps.silver.feed.lastLiveAt));
    v.expiries.forEach((e, i) => {
      const want = [...shortlist(e.screen, "PE"), ...shortlist(e.screen, "CE")].map((c) => `${c.strike}${c.type}`).sort();
      const got = doc.metals.silver.expiries[i].candidates.filter((c) => c.displayed).map((c) => `${c.strike}${c.type}`).sort();
      expect(got).toEqual(want);
    });
  });

  it("is deterministic: the clock is the snapshot's, not the wall clock", () => {
    expect(JSON.stringify(scoreAll(sellView, snaps))).toBe(JSON.stringify(doc));
  });

  it("lends yesterday's regime as the hysteresis memory", () => {
    const prev = { metals: { silver: { regime: { regime: "trend_up" } } } };
    expect(scoreAll(sellView, { silver: snaps.silver }, prev).metals.silver.prevRegime).toBe("trend_up");
    expect(doc.metals.silver.prevRegime).toBe(null);
  });
});
