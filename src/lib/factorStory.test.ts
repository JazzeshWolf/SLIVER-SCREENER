import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { factorStory } from "./factorStory";
import { scoreAllHorizons } from "./scoring";
import { METALS, METAL_IDS } from "./metals.mjs";
import type { FactorContribution, Horizon, LiveInputs, McxData } from "./types";

const emptyLive: LiveInputs = {
  metalUsd: null, xauUsd: null, usdInr: null, dxy: null, real10y: null, breakeven10y: null,
  metalHistory: [], xauHistory: [], dxyHistory: [], real10yHistory: [], usdInrHistory: [],
  asOf: "", partial: false,
};
const mcxWith = (fut: number, prevClose: number, oiChg: number): McxData => ({
  asOf: "", stale: false, partial: false,
  mcx: { symbol: "CRUDEOILM", fut, prevClose, expiry: null, dte: 23, oi: 39284, oiChg },
  options: { atmStrike: null, atmIv: null, ivRank: null, ivPercentile: null, rv20: null, expectedMove1sd: null, chain: [] },
  basis: { fairValue: null, basis: null },
  events: [],
});
const factor = (s: number): FactorContribution => ({ key: "mcxPositioning", label: "MCX OI / price", pillar: "deriv", raw: s, s, weight: 0.14, present: true });
const story = (fut: number, prev: number, oiChg: number, s: number) =>
  factorStory(factor(s), "1M", emptyLive, mcxWith(fut, prev, oiChg), METALS.crude)!;

describe("factorStory — MCX OI / price", () => {
  it("explains today's crude reading in plain words", () => {
    expect(story(8843, 9161, -4202, -0.73)).toBe(
      "CRUDEOILM futures fell 3.5% on the day (₹9,161 → ₹8,843) while open interest fell by 4,202 contracts. " +
        "Long unwinding: holders are exiting rather than new sellers arriving — bearish, though selling like this can run out of steam. " +
        "(A 4% day moves this factor all the way.) Reads bearish (-0.73).",
    );
  });

  it("names all four price/OI combinations", () => {
    expect(story(9000, 8900, 500, 0.3)).toContain("Fresh buying");
    expect(story(9000, 8900, -500, 0.4)).toContain("Short covering");
    expect(story(8800, 8900, 500, -0.3)).toContain("Fresh selling");
    expect(story(8800, 8900, -500, -0.4)).toContain("Long unwinding");
  });
});

// Every factor the engine scores on the real committed snapshots gets a live
// explanation, and the explanation's verdict matches the score's sign.
describe("factorStory — every factor on the real snapshots", () => {
  for (const id of METAL_IDS) {
    const file = `public/data/${id}.json`;
    it.skipIf(!existsSync(file))(`${id}: every scored factor explains itself`, () => {
      const { live, ...mcx } = JSON.parse(readFileSync(file, "utf8"));
      const scores = scoreAllHorizons(live, mcx as McxData, id);
      for (const h of ["1D", "1W", "1M"] as Horizon[]) {
        for (const f of scores[h].factors.filter((x) => x.present)) {
          const text = factorStory(f, h, live, mcx as McxData, METALS[id]);
          expect(text, `${id} ${h} ${f.key}`).toBeTruthy();
          const word = f.s > 0.05 ? "bullish" : f.s < -0.05 ? "bearish" : "neutral";
          expect(text, `${id} ${h} ${f.key}`).toContain(`Reads ${word}`);
          expect(text, `${id} ${h} ${f.key}`).not.toMatch(/NaN|undefined|Infinity/);
        }
      }
    });
  }
});
