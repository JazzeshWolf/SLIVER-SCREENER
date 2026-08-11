// ---------------------------------------------------------------------------
// Import-parity fair value and basis, for any metal in the registry.
//
//   FV    = intlPrice × unitMult × USD-INR × (1 + duty + GST)
//   basis = MCX futures − FV
//
// Every per-metal constant (unitMult, duty, GST) lives in metals.mjs, which the
// data builder imports too — so the client and the server can no longer drift
// apart on the parity numbers the way they did when each kept its own copy.
//
//   silver: $/oz × 32.1507   → ₹/kg     (troy oz per kg)
//   gold:   $/oz × 0.321507  → ₹/10g
//   copper: $/lb × 2.20462   → ₹/kg     — parityConfidence "approximate",
//           because the free feed is COMEX while MCX tracks LME, and the US
//           §232 tariff has held those hundreds of dollars a tonne apart.
// ---------------------------------------------------------------------------

import { parityMult } from "./metals.mjs";
import type { MetalConfig } from "./metals.mjs";

/** Troy ounces per kilogram — silver's unit conversion, kept for reference. */
export const TROY_OZ_PER_KG = 32.1507;

/**
 * Import-parity fair value in the metal's own quote unit (₹/kg, ₹/10g, …).
 * Returns null rather than a guess when either input is missing.
 */
export function fairValue(
  metal: MetalConfig,
  intlPrice: number | null,
  usdInr: number | null,
): number | null {
  if (intlPrice === null || usdInr === null || intlPrice <= 0 || usdInr <= 0) return null;
  return intlPrice * parityMult(metal) * usdInr;
}

export function basis(fut: number | null, fv: number | null): number | null {
  if (fut === null || fv === null) return null;
  return fut - fv;
}

/** India premium as a percentage of fair value (positive = local premium). */
export function premiumPct(fut: number | null, fv: number | null): number | null {
  if (fut === null || fv === null || fv === 0) return null;
  return ((fut - fv) / fv) * 100;
}

/**
 * Convert an MCX price back to the implied international price, so an MCX
 * quote can be overlaid on the international chart.
 */
export function toIntlPrice(
  metal: MetalConfig,
  inrPerUnit: number,
  usdInr: number,
): number | null {
  if (usdInr <= 0) return null;
  const m = parityMult(metal) * usdInr;
  return m > 0 ? inrPerUnit / m : null;
}
