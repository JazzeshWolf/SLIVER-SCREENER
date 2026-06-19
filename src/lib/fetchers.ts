// ---------------------------------------------------------------------------
// Live, browser-side data fetchers. Every source is free + CORS-enabled.
// Each fetcher fails soft: on error it returns null and the caller falls back
// to cached last-good values, flagging the result `partial`.
// ---------------------------------------------------------------------------

import type { LiveInputs, McxData, Point } from "./types";
import { cacheGet, cacheSet } from "./cache";

const BASE = import.meta.env.BASE_URL ?? "/";

async function timed<T>(p: Promise<T>, ms = 8000): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await timed(fetch(url, { headers: { accept: "application/json" } }));
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

async function getText(url: string): Promise<string> {
  const res = await timed(fetch(url));
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return await res.text();
}

// --- Spot metals (gold-api.com, no key, CORS) ------------------------------
async function fetchMetal(symbol: "XAU" | "XAG"): Promise<number | null> {
  try {
    const j = await getJson<{ price: number }>(`https://api.gold-api.com/price/${symbol}`);
    return typeof j.price === "number" ? j.price : null;
  } catch {
    return null;
  }
}

// --- USD-INR (frankfurter.app, no key, CORS) -------------------------------
async function fetchUsdInr(): Promise<number | null> {
  try {
    const j = await getJson<{ rates: { INR: number } }>(
      "https://api.frankfurter.app/latest?from=USD&to=INR",
    );
    return j.rates?.INR ?? null;
  } catch {
    // Fallback FX source.
    try {
      const j = await getJson<{ rates: { INR: number } }>("https://open.er-api.com/v6/latest/USD");
      return j.rates?.INR ?? null;
    } catch {
      return null;
    }
  }
}

// --- DXY + 10y yield via stooq CSV (CORS-friendly) -------------------------
// stooq returns "Symbol,Date,Time,Open,High,Low,Close,Volume".
async function fetchStooqLast(symbol: string): Promise<number | null> {
  try {
    const csv = await getText(`https://stooq.com/q/l/?s=${symbol}&f=sd2t2ohlcv&h&e=csv`);
    const lines = csv.trim().split("\n");
    if (lines.length < 2) return null;
    const cols = lines[1].split(",");
    const close = Number(cols[6]);
    return Number.isFinite(close) && close > 0 ? close : null;
  } catch {
    return null;
  }
}

// --- FRED daily series (real yield). Needs a free key in VITE_FRED_KEY. -----
// Falls back gracefully (returns null history) when no key is configured.
async function fetchFredSeries(seriesId: string): Promise<Point[]> {
  const key = import.meta.env.VITE_FRED_KEY;
  if (!key) return [];
  try {
    const url =
      `https://api.stlouisfed.org/fred/series/observations` +
      `?series_id=${seriesId}&api_key=${key}&file_type=json&sort_order=desc&limit=260`;
    const j = await getJson<{ observations: { date: string; value: string }[] }>(url);
    return j.observations
      .map((o) => ({ t: o.date, v: Number(o.value) }))
      .filter((p) => Number.isFinite(p.v))
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Append today's value to a cached rolling history so client-side z-scores have
 * something to chew on even when a full historical API isn't configured.
 */
function pushHistory(key: string, value: number | null, max = 260): Point[] {
  const today = new Date().toISOString().slice(0, 10);
  const prev = cacheGet<Point[]>(`hist:${key}`)?.value ?? [];
  let next = prev;
  if (value !== null && Number.isFinite(value)) {
    const filtered = prev.filter((p) => p.t !== today);
    next = [...filtered, { t: today, v: value }].slice(-max);
    cacheSet(`hist:${key}`, next);
  }
  return next;
}

export async function fetchLiveInputs(): Promise<LiveInputs> {
  const [xag, xau, usdInr, dxy, tnx, fredReal, fredNominal] = await Promise.all([
    fetchMetal("XAG"),
    fetchMetal("XAU"),
    fetchUsdInr(),
    fetchStooqLast("^dxy"),
    fetchStooqLast("^tnx"), // 10y nominal yield ×10 (fallback if no FRED)
    fetchFredSeries("DFII10"), // 10y real yield
    fetchFredSeries("DGS10"), // 10y nominal yield
  ]);

  // Build/extend rolling histories (cache-backed) for momentum & z-scores.
  const xagHistory = pushHistory("xag", xag);
  const xauHistory = pushHistory("xau", xau);
  const dxyHistory = pushHistory("dxy", dxy);
  const usdInrHistory = pushHistory("usdinr", usdInr);

  const real10y = fredReal.length ? fredReal[fredReal.length - 1].v : tnx !== null ? tnx / 10 - 2.3 : null;
  const real10yHistory = fredReal.length ? fredReal : pushHistory("real10y", real10y);

  const nominal10y = fredNominal.length ? fredNominal[fredNominal.length - 1].v : tnx !== null ? tnx / 10 : null;
  const breakeven10y =
    nominal10y !== null && real10y !== null ? round2(nominal10y - real10y) : null;

  const anyNull = [xag, xau, usdInr, dxy].some((v) => v === null);

  const live: LiveInputs = {
    xagUsd: xag,
    xauUsd: xau,
    usdInr,
    dxy,
    real10y,
    breakeven10y,
    xagHistory,
    xauHistory,
    dxyHistory,
    real10yHistory,
    usdInrHistory,
    asOf: new Date().toISOString(),
    partial: anyNull,
  };

  cacheSet("live", live);
  return live;
}

/** Read the most recent successfully-fetched live inputs (for offline boot). */
export function lastGoodLive(): LiveInputs | null {
  return cacheGet<LiveInputs>("live")?.value ?? null;
}

/** Load the Action-produced MCX snapshot (static JSON committed to the repo). */
export async function fetchMcxData(): Promise<McxData | null> {
  try {
    const j = await getJson<McxData>(`${BASE}data/latest.json?ts=${Date.now()}`);
    cacheSet("mcx", j);
    return j;
  } catch {
    return cacheGet<McxData>("mcx")?.value ?? null;
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
