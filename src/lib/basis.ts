// ---------------------------------------------------------------------------
// MCX silver fair-value (₹/kg) and basis. See blueprint §2C.
//   FV = XAGUSD ($/oz) × 32.1507 (oz/kg) × USD-INR × (1 + duty + GST)
//   basis = MCX futures − FV
// ---------------------------------------------------------------------------

export const TROY_OZ_PER_KG = 32.1507;

// Effective Indian import levies on silver. These step-change with duty
// notifications. Duty was hiked to 15% on 2026-05-13 (silver moved to the
// DGFT "Restricted" category), on top of 3% GST.
export const IMPORT_DUTY = 0.15; // 15% (BCD, post 2026-05-13 hike)
export const GST = 0.03; // 3%

export function fairValueInrPerKg(
  xagUsd: number | null,
  usdInr: number | null,
  duty = IMPORT_DUTY,
  gst = GST,
): number | null {
  if (xagUsd === null || usdInr === null || xagUsd <= 0 || usdInr <= 0) return null;
  return xagUsd * TROY_OZ_PER_KG * usdInr * (1 + duty + gst);
}

export function basis(silverFut: number | null, fv: number | null): number | null {
  if (silverFut === null || fv === null) return null;
  return silverFut - fv;
}

/** India premium as a percentage of fair value (positive = local premium). */
export function premiumPct(silverFut: number | null, fv: number | null): number | null {
  if (silverFut === null || fv === null || fv === 0) return null;
  return ((silverFut - fv) / fv) * 100;
}

/** Convert an MCX ₹/kg price back to an implied $/oz, to overlay on intl spot. */
export function inrPerKgToUsdPerOz(
  inrPerKg: number,
  usdInr: number,
  duty = IMPORT_DUTY,
  gst = GST,
): number | null {
  if (usdInr <= 0) return null;
  return inrPerKg / (TROY_OZ_PER_KG * usdInr * (1 + duty + gst));
}
