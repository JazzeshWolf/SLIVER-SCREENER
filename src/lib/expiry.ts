// ---------------------------------------------------------------------------
// Contract clock. `dte` / `optionDte` in a snapshot are stamped when the data
// Action last ran, and that Action only runs Mon–Fri 03:30–18:00 UTC — so
// overnight, all weekend, or whenever the Upstox token dies, those counts
// freeze along with everything else. Left alone the picker keeps offering a
// contract that has already expired, wearing the DTE it had on the last good
// run (a Friday-expiring option still reads "0d · selectable" on Sunday).
//
// The browser's own clock is the authority here: every day count is recomputed
// against today, expired contracts drop out of the picker, and the view
// re-points to the nearest contract that is actually still alive.
// ---------------------------------------------------------------------------

import type { ExpiryBundle, McxData } from "./types";

/** Calendar date in IST (MCX's timezone) as "YYYY-MM-DD". */
export function istDate(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/**
 * Whole IST days from today to an expiry: 0 on expiry day (the contract still
 * trades until the close), negative once it has passed, null when undated.
 */
export function daysTo(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const at = Date.parse(iso.slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(at)) return null;
  return Math.round((at - Date.parse(istDate(now) + "T00:00:00Z")) / 86400000);
}

/** True while a contract can still be traded — expiry day counts as alive. */
export function isLive(iso: string | null | undefined, now: Date = new Date()): boolean {
  const d = daysTo(iso, now);
  return d == null || d >= 0;
}

/** Re-time one bundle's day counts against today. */
function retimeBundle(b: ExpiryBundle, now: Date): ExpiryBundle {
  const dte = daysTo(b.expiry, now);
  const optionDte = daysTo(b.optionExpiry, now);
  return {
    ...b,
    dte: dte == null ? b.dte : Math.max(0, dte),
    optionDte: optionDte == null ? b.optionDte : Math.max(0, optionDte),
  };
}

/** Swap a bundle's contract data into the top-level mcx view. */
export function mergeExpiry(mcx: McxData | null, sel: string | null): McxData | null {
  const exs = mcx?.expiries;
  if (!mcx || !exs?.length || !sel || sel === mcx.mcx.optionExpiry) return mcx;
  const b = exs.find((e) => e.optionExpiry === sel);
  if (!b) return mcx;
  return {
    ...mcx,
    mcx: {
      ...mcx.mcx,
      fut: b.fut,
      prevClose: b.prevClose,
      oi: b.oi,
      oiChg: b.oiChg,
      expiry: b.expiry,
      dte: b.dte,
      optionExpiry: b.optionExpiry,
      optionDte: b.optionDte,
    },
    options: {
      ...mcx.options,
      atmStrike: b.atmStrike,
      atmIv: b.atmIv,
      ivEstimated: b.ivEstimated,
      ivRank: b.ivRank,
      ivPercentile: b.ivPercentile,
      ivRankEstimated: b.ivRankEstimated,
      expectedMove1sd: b.expectedMove1sd,
      chain: b.chain,
    },
    gex: b.gex,
    basis: b.basis,
  };
}

/**
 * Re-time a snapshot against the browser clock:
 *  - every bundle's `dte`/`optionDte` recounted from today;
 *  - expired bundles and expiry dates dropped;
 *  - the view re-pointed to the nearest live contract when the one the
 *    snapshot defaulted to has since expired.
 *
 * When every listed contract has expired the snapshot is too old to trade off:
 * the bundles are kept (so the cards still say which contract they describe)
 * and `contractsExpired` is set for the UI to say so out loud.
 */
export function retimeSnapshot(mcx: McxData | null, now: Date = new Date()): McxData | null {
  if (!mcx) return mcx;

  const bundles = (mcx.expiries ?? []).map((b) => retimeBundle(b, now));
  const live = bundles.filter((b) => isLive(b.optionExpiry, now));
  const contractsExpired = bundles.length > 0 && live.length === 0;

  const dte = daysTo(mcx.mcx.expiry, now);
  const optionDte = daysTo(mcx.mcx.optionExpiry, now);
  const timed: McxData = {
    ...mcx,
    contractsExpired,
    expiries: mcx.expiries ? (live.length ? live : bundles) : mcx.expiries,
    mcx: {
      ...mcx.mcx,
      dte: dte == null ? mcx.mcx.dte : Math.max(0, dte),
      optionDte: optionDte == null ? mcx.mcx.optionDte : Math.max(0, optionDte),
      optionExpiries: mcx.mcx.optionExpiries?.filter((d) => isLive(d, now)) ?? mcx.mcx.optionExpiries,
    },
  };

  // The snapshot's default contract died since the last data run — show the
  // nearest one that hasn't, rather than a dead chain under a live heading.
  if (live.length && !isLive(timed.mcx.optionExpiry, now)) {
    return mergeExpiry(timed, live[0].optionExpiry);
  }
  return timed;
}
