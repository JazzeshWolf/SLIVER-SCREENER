// ---------------------------------------------------------------------------
// Option-chain aggregates for the Chain / OI tab. Pure functions over the
// per-expiry OptionQuote[] the server already provides.
// ---------------------------------------------------------------------------

import type { OptionQuote } from "./types";

export interface StrikeRow {
  strike: number;
  ce?: { ltp: number; iv: number | null; oi: number };
  pe?: { ltp: number; iv: number | null; oi: number };
}

/** Pivot a flat chain into per-strike rows (both sides), sorted high → low. */
export function pivotByStrike(chain: OptionQuote[]): StrikeRow[] {
  const byStrike = new Map<number, StrikeRow>();
  for (const o of chain) {
    if (!(o.strike > 0)) continue;
    const row = byStrike.get(o.strike) ?? { strike: o.strike };
    const leg = { ltp: o.ltp, iv: o.iv, oi: o.oi ?? 0 };
    if (o.type === "CE") row.ce = leg;
    else row.pe = leg;
    byStrike.set(o.strike, row);
  }
  return [...byStrike.values()].sort((a, b) => b.strike - a.strike);
}

/** Put-Call Ratio by open interest (ΣputOI / ΣcallOI). Null if no call OI. */
export function pcr(chain: OptionQuote[]): number | null {
  let put = 0;
  let call = 0;
  for (const o of chain) {
    if (o.type === "PE") put += o.oi ?? 0;
    else call += o.oi ?? 0;
  }
  return call > 0 ? put / call : null;
}

/** ATM straddle premium = CE ltp + PE ltp at the strike nearest `atmStrike`. */
export function straddleAtm(chain: OptionQuote[], atmStrike: number | null): number | null {
  if (atmStrike == null) return null;
  const strikes = [...new Set(chain.map((o) => o.strike))];
  if (!strikes.length) return null;
  const k = strikes.reduce((b, s) => (Math.abs(s - atmStrike) < Math.abs(b - atmStrike) ? s : b), strikes[0]);
  const ce = chain.find((o) => o.strike === k && o.type === "CE");
  const pe = chain.find((o) => o.strike === k && o.type === "PE");
  if (!ce || !pe) return null;
  return ce.ltp + pe.ltp;
}

/**
 * Skew ≈ OTM put IV − OTM call IV at roughly equal distance from spot, in vol
 * points (×100). Positive = puts bid = downside fear priced. Picks the nearest
 * OTM put/call that have IV, at a comparable distance.
 */
export function skew25(chain: OptionQuote[], spot: number | null): number | null {
  if (spot == null || spot <= 0) return null;
  const dist = spot * 0.03; // ~3% OTM, a stable proxy for a 25-delta wing
  const pick = (type: "CE" | "PE", target: number) => {
    const cands = chain.filter((o) => o.type === type && o.iv != null && o.iv > 0);
    if (!cands.length) return null;
    return cands.reduce((b, o) => (Math.abs(o.strike - target) < Math.abs(b.strike - target) ? o : b), cands[0]);
  };
  const put = pick("PE", spot - dist);
  const call = pick("CE", spot + dist);
  if (!put?.iv || !call?.iv) return null;
  return (put.iv - call.iv) * 100;
}

/** Top-N strikes by OI on one side (resistances = CE, supports = PE). */
export function topByOi(chain: OptionQuote[], type: "CE" | "PE", n = 3): { strike: number; oi: number }[] {
  return chain
    .filter((o) => o.type === type && (o.oi ?? 0) > 0)
    .map((o) => ({ strike: o.strike, oi: o.oi }))
    .sort((a, b) => b.oi - a.oi)
    .slice(0, n);
}

/** Net OI change written today per side (Σ oiChg). Nulls skipped. */
export function oiWritten(chain: OptionQuote[]): { call: number; put: number } {
  let call = 0;
  let put = 0;
  for (const o of chain) {
    if (o.oiChg == null || !Number.isFinite(o.oiChg)) continue;
    if (o.type === "PE") put += o.oiChg;
    else call += o.oiChg;
  }
  return { call, put };
}

/** True when any leg carries a real (non-null) OI change — enables the Δ view. */
export function hasOiChg(chain: OptionQuote[]): boolean {
  return chain.some((o) => o.oiChg != null && Number.isFinite(o.oiChg));
}

/** Compact Indian OI formatting: 380000 → "3.8L", 15000 → "15k", 900 → "900". */
export function fmtOi(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${Math.round(n)}`;
}

/** Signed compact OI, e.g. +15k / −3k (for OI-change display). */
export function fmtOiSigned(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  return (n > 0 ? "+" : "−") + fmtOi(Math.abs(n));
}
