// ---------------------------------------------------------------------------
// "Recent prints" window — the radar's macro prints are only useful while they
// are still the *latest* read. A Fed rate that last moved in February is not
// news in August, so anything older than the trailing 2-month window is
// dropped rather than shown as if it just printed.
// ---------------------------------------------------------------------------

import type { EconPrint } from "./types";

/** How many calendar months back from the current one still count as recent. */
const WINDOW_MONTHS = 2;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Months elapsed between a print and `now`, or null when the print carries no
 * readable date. Prefers the builder's ISO `date` (the FRED reference month)
 * and falls back to parsing the display `period` ("Jul 26") so prints written
 * by older data builds still get filtered.
 */
function monthsAgo(p: EconPrint, now: Date): number | null {
  let y: number;
  let m: number;

  if (p.date) {
    const d = new Date(p.date + (p.date.length === 10 ? "T00:00:00Z" : ""));
    if (Number.isNaN(d.getTime())) return null;
    y = d.getUTCFullYear();
    m = d.getUTCMonth();
  } else {
    const match = /^\s*([A-Za-z]{3})[a-z]*\.?\s+'?(\d{2}|\d{4})\s*$/.exec(p.period ?? "");
    if (!match) return null;
    m = MONTHS.indexOf(match[1].toLowerCase());
    if (m < 0) return null;
    const yy = Number(match[2]);
    y = match[2].length === 2 ? 2000 + yy : yy;
  }

  return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() - m);
}

/**
 * Keep only prints from the current month and the `WINDOW_MONTHS` before it.
 * Undated prints are kept — hiding a reading we simply cannot date is worse
 * than showing it, and future-dated ones (a timezone edge) are kept too.
 */
export function recentPrints(prints: EconPrint[] | null | undefined, now: Date = new Date()): EconPrint[] {
  return (prints ?? []).filter((p) => {
    const age = monthsAgo(p, now);
    return age == null || age <= WINDOW_MONTHS;
  });
}
