// ---------------------------------------------------------------------------
// Silver "fear gauge" — there is no official Silver VIX (CBOE's VXSLV was
// discontinued), so we build the India-VIX analog from silver's OWN option
// implied vol: a 30-day constant-maturity ATM IV interpolated across expiries.
// ---------------------------------------------------------------------------

import type { ExpiryBundle } from "./types";

const TARGET_DAYS = 30; // India VIX is a 30-day constant-maturity number

export interface Vix30 {
  iv: number; // annualized ATM IV, fraction (0.34 = 34%)
  estimated: boolean; // true if any leg used a realized-vol proxy
  source: "30d" | "front"; // interpolated to 30d, or the nearest single expiry
}

/**
 * 30-day constant-maturity ATM IV, à la VIX: interpolate total variance
 * (iv²·t) linearly in DTE between the two expiries bracketing 30 days, then
 * take the root. Falls back to the nearest expiry when 30d isn't bracketed.
 */
export function iv30d(expiries: ExpiryBundle[] | null | undefined): Vix30 | null {
  const xs = (expiries ?? [])
    .filter((e) => e.atmIv != null && e.atmIv > 0 && e.optionDte > 0)
    .map((e) => ({ iv: e.atmIv as number, t: e.optionDte, est: !!e.ivEstimated }))
    .sort((a, b) => a.t - b.t);
  if (!xs.length) return null;

  if (TARGET_DAYS <= xs[0].t) return { iv: xs[0].iv, estimated: xs[0].est, source: "front" };
  const last = xs[xs.length - 1];
  if (TARGET_DAYS >= last.t) return { iv: last.iv, estimated: last.est, source: "front" };

  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i];
    const b = xs[i + 1];
    if (a.t <= TARGET_DAYS && TARGET_DAYS <= b.t) {
      const w = (TARGET_DAYS - a.t) / (b.t - a.t);
      // Interpolate variance linearly in time, then re-annualize to the root.
      const varA = a.iv * a.iv * a.t;
      const varB = b.iv * b.iv * b.t;
      const varT = ((1 - w) * varA + w * varB) / TARGET_DAYS;
      return { iv: Math.sqrt(Math.max(varT, 0)), estimated: a.est || b.est, source: "30d" };
    }
  }
  return { iv: xs[0].iv, estimated: xs[0].est, source: "front" };
}

export interface FearZone {
  label: string;
  tone: "bull" | "neutral" | "warn" | "bear";
  color: string; // hex for the gauge needle/zone
  sellerNote: string;
}

/**
 * Map an IV percentile (0..100 vs the contract's own history) to a fear band.
 * Low IV = complacency (thin premium); high IV = fear (premium rich for sellers).
 */
export function fearZone(percentile: number | null): FearZone {
  const p = percentile ?? 50;
  if (p < 15)
    return { label: "Complacent", tone: "neutral", color: "#38bdf8", sellerNote: "IV near lows — premium is thin. Sell smaller or wider; poor risk/reward for fresh shorts." };
  if (p < 40)
    return { label: "Calm", tone: "bull", color: "#4ade80", sellerNote: "Below-average fear — decent but not rich premium. Standard strikes, normal size." };
  if (p < 65)
    return { label: "Normal", tone: "neutral", color: "#eab308", sellerNote: "Fear around its median — premium is fair. Nothing extreme either way." };
  if (p < 85)
    return { label: "Elevated", tone: "warn", color: "#f97316", sellerNote: "Fear elevated — premium is rich. Good for selling, but respect the bigger expected move." };
  return { label: "Extreme fear", tone: "bear", color: "#ef4444", sellerNote: "Fear at an extreme — richest premium, but moves are violent. Sell far OTM, smaller size, mind event risk." };
}
