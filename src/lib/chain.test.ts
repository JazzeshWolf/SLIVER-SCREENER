import { describe, expect, it } from "vitest";
import { pivotByStrike, pcr, straddleAtm, skew25, topByOi, fmtOi } from "./chain";
import type { OptionQuote } from "./types";

const q = (strike: number, type: "CE" | "PE", ltp: number, iv: number | null, oi: number): OptionQuote => ({
  strike, type, ltp, iv, oi,
});

const chain: OptionQuote[] = [
  q(56000, "CE", 1600, 0.30, 16000),
  q(56000, "PE", 624, 0.30, 190000),
  q(57000, "CE", 1285, 0.148, 110000),
  q(57000, "PE", 805, 0.148, 270000),
  q(58000, "CE", 752, 0.141, 380000),
  q(58000, "PE", 1282, 0.141, 5000),
];

describe("chain helpers", () => {
  it("pivots into per-strike rows sorted high → low", () => {
    const rows = pivotByStrike(chain);
    expect(rows.map((r) => r.strike)).toEqual([58000, 57000, 56000]);
    expect(rows[0].ce?.oi).toBe(380000);
    expect(rows[0].pe?.oi).toBe(5000);
  });

  it("computes PCR = ΣputOI / ΣcallOI", () => {
    const put = 190000 + 270000 + 5000;
    const call = 16000 + 110000 + 380000;
    expect(pcr(chain)).toBeCloseTo(put / call, 6);
    expect(pcr([])).toBeNull();
  });

  it("straddle = ATM CE ltp + PE ltp at the nearest strike", () => {
    expect(straddleAtm(chain, 57000)).toBe(1285 + 805);
    expect(straddleAtm(chain, 57100)).toBe(1285 + 805); // snaps to 57000
    expect(straddleAtm([], 57000)).toBeNull();
  });

  it("skew is positive when OTM puts carry more IV than OTM calls", () => {
    // spot 57000: OTM put ~55290 → nearest 56000 (iv .30); OTM call ~58710 → 58000 (iv .141)
    const s = skew25(chain, 57000)!;
    expect(s).toBeGreaterThan(0);
    expect(s).toBeCloseTo((0.30 - 0.141) * 100, 6);
  });

  it("topByOi returns the biggest-OI strikes per side", () => {
    expect(topByOi(chain, "CE", 2)).toEqual([
      { strike: 58000, oi: 380000 },
      { strike: 57000, oi: 110000 },
    ]);
    expect(topByOi(chain, "PE", 1)).toEqual([{ strike: 57000, oi: 270000 }]);
  });

  it("formats OI compactly", () => {
    expect(fmtOi(380000)).toBe("3.8L");
    expect(fmtOi(15000)).toBe("15k");
    expect(fmtOi(900)).toBe("900");
    expect(fmtOi(null)).toBe("—");
  });
});
