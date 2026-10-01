// ---------------------------------------------------------------------------
// The live futures curve, read out in one plain sentence with its own prices:
//
//   "The live market says the futures curve is steeply backwardated (October
//    ₹8,843, November ₹8,511, December ₹8,281), which signals a tight market."
//
// For crude this reading replaces a fixed structural opinion (owner's call,
// 2026-09-26): the direction engine weighs the curve itself (`termStructure`),
// and the screen says in words what the curve says. One function so the Score
// tab, the Outlook and the curve card can never tell three different stories.
// ---------------------------------------------------------------------------

import type { CurveData } from "./types";

export interface CurveRead {
  /** What the curve implies for price: backwardation up, contango down. */
  stance: "up" | "down" | "neutral";
  text: string;
}

const MONTH_NAMES: Record<string, string> = {
  Jan: "January", Feb: "February", Mar: "March", Apr: "April", May: "May", Jun: "June",
  Jul: "July", Aug: "August", Sep: "September", Oct: "October", Nov: "November", Dec: "December",
};

/** Annualized slope (%/yr) from which the curve counts as "steep". */
const STEEP_PCT = 15;
/** Below this it is only "mildly" sloped. */
const MILD_PCT = 5;

/**
 * Null when there is no real curve to read: nothing fetched, fewer than two
 * months, or a front-vs-spot "carry" approximation (which is not a curve).
 */
export function curveRead(c: CurveData | null | undefined): CurveRead | null {
  if (!c || c.source === "carry" || c.months.length < 2 || !Number.isFinite(c.annualizedPct)) return null;
  const rupees = c.source === "mcx";
  const price = (v: number) =>
    rupees
      ? `₹${Math.round(v).toLocaleString("en-IN")}`
      : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const months = c.months
    .map((m) => `${MONTH_NAMES[m.label.slice(0, 3)] ?? m.label} ${price(m.price)}`)
    .join(", ");
  const slope = Math.abs(c.annualizedPct);
  const degree = slope >= STEEP_PCT ? "steeply " : slope < MILD_PCT ? "mildly " : "";

  if (c.structure === "backwardation") {
    return {
      stance: "up",
      text: `The live market says the futures curve is ${degree}backwardated (${months}), which signals a tight market.`,
    };
  }
  if (c.structure === "contango") {
    return {
      stance: "down",
      text: `The live market says the futures curve is ${degree}in contango (${months}), which signals ${slope >= STEEP_PCT ? "a glut" : "ample supply"}.`,
    };
  }
  return {
    stance: "neutral",
    text: `The live market says the futures curve is flat (${months}), which signals a balanced market — neither tight nor oversupplied.`,
  };
}
