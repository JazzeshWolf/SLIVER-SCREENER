import { describe, expect, it } from "vitest";
import { curveRead } from "./curveRead";
import type { CurveData } from "./types";

const strip = (annualizedPct: number, structure: CurveData["structure"], prices: number[], source: CurveData["source"] = "mcx"): CurveData => ({
  front: prices[0],
  structure,
  annualizedPct,
  source,
  months: prices.map((price, i) => ({ label: ["Oct'26", "Nov'26", "Dec'26", "Jan'27"][i], price })),
});

describe("curveRead", () => {
  it("reads the first live crude curve exactly the way the owner asked for it", () => {
    expect(curveRead(strip(-38.66, "backwardation", [8843, 8511, 8281]))).toEqual({
      stance: "up",
      text: "The live market says the futures curve is steeply backwardated (October ₹8,843, November ₹8,511, December ₹8,281), which signals a tight market.",
    });
  });

  it("grades the slope: mildly, plainly, steeply", () => {
    expect(curveRead(strip(-3, "backwardation", [8800, 8780]))!.text).toContain("is mildly backwardated");
    expect(curveRead(strip(-8, "backwardation", [8800, 8740]))!.text).toContain("is backwardated");
  });

  it("reads contango as supply, and a steep one as a glut", () => {
    const mild = curveRead(strip(8, "contango", [5500, 5540, 5570]))!;
    expect(mild.stance).toBe("down");
    expect(mild.text).toContain("is in contango (October ₹5,500, November ₹5,540, December ₹5,570), which signals ample supply.");
    expect(curveRead(strip(30, "contango", [5500, 5640]))!.text).toContain("which signals a glut.");
  });

  it("reads a flat curve as balanced", () => {
    const r = curveRead(strip(0.2, "flat", [8800, 8801]))!;
    expect(r.stance).toBe("neutral");
    expect(r.text).toContain("is flat");
  });

  it("prices an international curve in dollars", () => {
    expect(curveRead(strip(-10, "backwardation", [92.3, 91.1], "curve"))!.text).toContain("(October $92.30, November $91.10)");
  });

  it("says nothing without a real curve", () => {
    expect(curveRead(null)).toBeNull();
    expect(curveRead(strip(-10, "backwardation", [8843]))).toBeNull(); // one month is not a curve
    expect(curveRead(strip(-10, "backwardation", [92.3, 91.1], "carry"))).toBeNull(); // front-vs-spot
  });
});
