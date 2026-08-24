import { describe, expect, it } from "vitest";
import { recentPrints } from "./prints";
import type { EconPrint } from "./types";

// Minimal EconPrint factory — only period/date matter to the window filter.
function pr(name: string, period: string, date?: string): EconPrint {
  return { kind: "other", name, period, date, actual: 1, prior: 1, unit: "%", impact: "twoway", note: "" };
}

const NOW = new Date("2026-08-24T00:00:00Z");

describe("recentPrints — trailing 2-month window", () => {
  it("keeps the current month and the two before it", () => {
    const kept = recentPrints(
      [pr("aug", "Aug 26", "2026-08-01"), pr("jul", "Jul 26", "2026-07-01"), pr("jun", "Jun 26", "2026-06-01")],
      NOW,
    );
    expect(kept.map((p) => p.name)).toEqual(["aug", "jul", "jun"]);
  });

  it("drops a print older than the window (a Fed rate last moved in February)", () => {
    const kept = recentPrints([pr("jul", "Jul 26", "2026-07-01"), pr("feb", "Feb 26", "2026-02-18")], NOW);
    expect(kept.map((p) => p.name)).toEqual(["jul"]);
  });

  it("drops the month just outside the window, not the last one inside it", () => {
    const kept = recentPrints([pr("jun", "Jun 26", "2026-06-30"), pr("may", "May 26", "2026-05-31")], NOW);
    expect(kept.map((p) => p.name)).toEqual(["jun"]);
  });

  it("falls back to the display period when a print carries no ISO date", () => {
    const kept = recentPrints([pr("jul", "Jul 26"), pr("dec", "Dec 25"), pr("sep", "Sep 25")], NOW);
    expect(kept.map((p) => p.name)).toEqual(["jul"]);
  });

  it("crosses the year boundary via the period fallback", () => {
    const kept = recentPrints(
      [pr("jan", "Jan 26"), pr("dec", "Dec 25"), pr("nov", "Nov 25"), pr("oct", "Oct 25")],
      new Date("2026-01-15T00:00:00Z"),
    );
    expect(kept.map((p) => p.name)).toEqual(["jan", "dec", "nov"]);
  });

  it("keeps prints it cannot date rather than hiding them", () => {
    const kept = recentPrints([pr("odd", "latest"), pr("blank", "")], NOW);
    expect(kept).toHaveLength(2);
  });

  it("keeps a future-dated print (timezone edge) and handles empty input", () => {
    expect(recentPrints([pr("sep", "Sep 26", "2026-09-01")], NOW)).toHaveLength(1);
    expect(recentPrints(undefined, NOW)).toEqual([]);
    expect(recentPrints(null, NOW)).toEqual([]);
  });
});
