#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Sliver Screener — server-side data builder (runs in GitHub Actions).
//
// Fetches ALL market data here (open internet, no CORS limits) and writes a
// single self-contained snapshot the browser renders directly:
//   public/data/latest.json  =  { live: {...histories...}, ...mcx... }
//
// Sources (all free):
//   * stooq.com daily CSV  -> XAGUSD, XAUUSD, DXY, USD-INR histories
//   * gold-api.com         -> latest spot tick
//   * frankfurter.app      -> latest USD-INR
//   * FRED (optional key)  -> 10y real yield (DFII10) + nominal (DGS10)
//   * MCX bhavcopy         -> real SILVERM future/options (best-effort)
//
// When MCX exchange data is unavailable, MCX price is computed from import
// parity and IV is estimated from realized vol — the snapshot is flagged
// `estimated:true` so the UI labels it. Always fails soft to last-good.
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toRaw } from "./bhavcopy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../public/data");
const LATEST = resolve(DATA_DIR, "latest.json");

const TROY_OZ_PER_KG = 32.1507;
const IMPORT_DUTY = 0.15;
const GST = 0.03;
const PARITY_MULT = TROY_OZ_PER_KG * (1 + IMPORT_DUTY + GST);
const MCX_SYMBOL = (process.env.MCX_SYMBOL || "SILVERM").toUpperCase();

// --- small stats -----------------------------------------------------------
function std(xs) {
  if (xs.length < 2) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function logReturns(v) {
  const r = [];
  for (let i = 1; i < v.length; i++) if (v[i - 1] > 0 && v[i] > 0) r.push(Math.log(v[i] / v[i - 1]));
  return r;
}
function realizedVol(v, n = 20) {
  const slice = v.slice(-Math.min(v.length, n + 1));
  const s = std(logReturns(slice));
  return Number.isFinite(s) ? s * Math.sqrt(252) : null;
}
function rangeRank(x, sample) {
  if (!sample.length) return null;
  const lo = Math.min(...sample), hi = Math.max(...sample);
  return hi === lo ? 50 : Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100));
}
function round(x, d) {
  if (x == null || !Number.isFinite(x)) return null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

async function getText(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}
async function getJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// --- stooq daily history ---------------------------------------------------
function ymd(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
async function stooqHistory(symbol, days = 180) {
  const d2 = new Date();
  const d1 = new Date(Date.now() - days * 86400000);
  const s = encodeURIComponent(symbol);
  const url = `https://stooq.com/q/d/l/?s=${s}&d1=${ymd(d1)}&d2=${ymd(d2)}&i=d`;
  try {
    const csv = await getText(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const lines = csv.trim().split("\n");
    if (lines.length < 2 || !/Date/i.test(lines[0])) return [];
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(",");
      const t = c[0];
      const close = Number(c[4]);
      if (t && Number.isFinite(close) && close > 0) out.push({ t, v: close });
    }
    return out;
  } catch (e) {
    console.warn(`stooq ${symbol}: ${e.message}`);
    return [];
  }
}

// Yahoo Finance v8 chart API — keyless daily history (server-side only).
async function yahooHistory(symbol, range = "6mo") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  try {
    const j = await getJson(url, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0" } });
    const r = j?.chart?.result?.[0];
    const ts = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const v = closes[i];
      if (Number.isFinite(v) && v > 0) out.push({ t: new Date(ts[i] * 1000).toISOString().slice(0, 10), v });
    }
    return out;
  } catch (e) {
    console.warn(`yahoo ${symbol}: ${e.message}`);
    return [];
  }
}

// Fetch a daily series trying multiple providers until one returns data.
async function fetchSeries(name, yahooSym, stooqSym) {
  let h = await yahooHistory(yahooSym);
  if (h.length > 5) {
    console.log(`${name}: yahoo ${h.length} pts`);
    return h;
  }
  h = await stooqHistory(stooqSym);
  console.log(`${name}: stooq ${h.length} pts`);
  return h;
}

async function goldApi(sym) {
  try {
    const j = await getJson(`https://api.gold-api.com/price/${sym}`);
    return typeof j.price === "number" ? j.price : null;
  } catch {
    return null;
  }
}
async function frankfurterInr() {
  try {
    const j = await getJson("https://api.frankfurter.app/latest?from=USD&to=INR");
    return j.rates?.INR ?? null;
  } catch {
    return null;
  }
}
async function fredSeries(id) {
  const key = process.env.FRED_KEY;
  if (!key) return [];
  try {
    const j = await getJson(
      `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc&limit=200`,
    );
    return j.observations
      .map((o) => ({ t: o.date, v: Number(o.value) }))
      .filter((p) => Number.isFinite(p.v))
      .reverse();
  } catch (e) {
    console.warn(`FRED ${id}: ${e.message}`);
    return [];
  }
}

/** Append/replace today's point with a fresher live value. */
function withLatest(hist, value) {
  if (value == null || !Number.isFinite(value)) return hist;
  const today = new Date().toISOString().slice(0, 10);
  const filtered = hist.filter((p) => p.t !== today);
  return [...filtered, { t: today, v: value }];
}

// --- MCX integration (token-free bhavcopy, best-effort) --------------------
const MCX_BHAVCOPY_URL = "https://www.mcxindia.com/backpage.aspx/GetDateWiseBhavCopy";
const MCX_HEADERS = {
  "Content-Type": "application/json; charset=UTF-8",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36",
  Referer: "https://www.mcxindia.com/market-data/bhavcopy",
  Origin: "https://www.mcxindia.com",
};
function recentTradingDays(count, from = new Date()) {
  const out = [];
  const d = new Date(from);
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}
async function fetchBhavRows(dateIso, cookie) {
  const [y, m, d] = dateIso.split("-");
  const res = await fetch(MCX_BHAVCOPY_URL, {
    method: "POST",
    headers: cookie ? { ...MCX_HEADERS, Cookie: cookie } : MCX_HEADERS,
    body: JSON.stringify({ Date: `${m}/${d}/${y}` }),
  });
  if (!res.ok) throw new Error(`bhavcopy ${dateIso} -> ${res.status}`);
  const j = await res.json();
  let p = j?.d ?? j;
  if (typeof p === "string") p = JSON.parse(p);
  const rows = p?.Data ?? p?.data ?? p;
  return Array.isArray(rows) ? rows : [];
}
async function fetchMcxReal() {
  let cookie = "";
  try {
    const r = await fetch("https://www.mcxindia.com/market-data/bhavcopy", {
      headers: { "User-Agent": MCX_HEADERS["User-Agent"] },
    });
    cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  } catch {}
  const today = new Date().toISOString().slice(0, 10);
  for (const iso of recentTradingDays(6)) {
    try {
      const rows = await fetchBhavRows(iso, cookie);
      if (rows.length) return toRaw(rows, MCX_SYMBOL, today, null);
    } catch (e) {
      console.warn(`  ${e.message}`);
    }
  }
  return null;
}

/** Next monthly expiry estimate: last weekday of the current month (roll if near). */
function nextMonthlyExpiry(today = new Date()) {
  function lastWeekday(year, monthIdx) {
    const d = new Date(Date.UTC(year, monthIdx + 1, 0)); // last day of month
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }
  let y = today.getUTCFullYear();
  let mo = today.getUTCMonth();
  let exp = lastWeekday(y, mo);
  const dte = Math.ceil((exp.getTime() - today.getTime()) / 86400000);
  if (dte < 2) {
    mo += 1;
    if (mo > 11) { mo = 0; y += 1; }
    exp = lastWeekday(y, mo);
  }
  return exp;
}

function builtinEvents() {
  // Lightweight static calendar; refine as needed. Dates in 2026.
  return [
    { name: "US CPI", date: "2026-07-10", kind: "us_cpi" },
    { name: "FOMC decision", date: "2026-07-29", kind: "fomc" },
    { name: "US Jobs (NFP)", date: "2026-07-02", kind: "us_jobs" },
  ];
}

async function loadLatest() {
  try {
    return JSON.parse(await readFile(LATEST, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const prev = await loadLatest();

  // 1) Histories (server-side, reliable).
  const [xagH, xauH, dxyH, inrH, fredReal, fredNom] = await Promise.all([
    fetchSeries("xag", "SI=F", "xagusd"),
    fetchSeries("xau", "GC=F", "xauusd"),
    fetchSeries("dxy", "DX-Y.NYB", "^dxy"),
    fetchSeries("usdinr", "INR=X", "usdinr"),
    fredSeries("DFII10"),
    fredSeries("DGS10"),
  ]);

  // 2) Latest spot/FX ticks (fresher than the daily close).
  const [xagSpot, xauSpot, inrSpot] = await Promise.all([goldApi("XAG"), goldApi("XAU"), frankfurterInr()]);

  const xagHistory = withLatest(xagH, xagSpot);
  const xauHistory = withLatest(xauH, xauSpot);
  const usdInrHistory = withLatest(inrH, inrSpot);
  const dxyHistory = dxyH;

  const haveCore = xagHistory.length > 5 && xauHistory.length > 5 && usdInrHistory.length > 5;
  if (!haveCore) {
    if (prev) {
      await writeFile(LATEST, JSON.stringify({ ...prev, mcx: { ...prev.mcx, stale: true } }, null, 2) + "\n");
      console.warn("Core history unavailable; preserved last-good as stale.");
    } else {
      console.warn("Core history unavailable and no prior snapshot.");
    }
    return;
  }

  const last = (h) => (h.length ? h[h.length - 1].v : null);
  const xagUsd = last(xagHistory);
  const xauUsd = last(xauHistory);
  const usdInr = last(usdInrHistory);
  const dxy = last(dxyHistory);
  const real10y = fredReal.length ? fredReal[fredReal.length - 1].v : null;
  const nominal10y = fredNom.length ? fredNom[fredNom.length - 1].v : null;
  const breakeven10y = nominal10y != null && real10y != null ? round(nominal10y - real10y, 2) : null;
  const real10yHistory = fredReal;

  // 3) MCX: real bhavcopy if reachable, else import-parity estimate.
  const realMcx = await fetchMcxReal();
  const fairValue = xagUsd != null && usdInr != null ? xagUsd * PARITY_MULT * usdInr : null;

  const expiry = nextMonthlyExpiry();
  const expiryIso = expiry.toISOString().slice(0, 10);
  const dte = Math.max(0, Math.ceil((expiry.getTime() - Date.now()) / 86400000));
  const t = dte / 365;

  const xagCloses = xagHistory.map((p) => p.v);
  const rv20 = realizedVol(xagCloses, 20);
  // Rolling 20d realized-vol series -> IV rank proxy.
  const rvSeries = [];
  for (let i = 21; i < xagCloses.length; i++) rvSeries.push(realizedVol(xagCloses.slice(i - 21, i + 1), 20));
  const rvClean = rvSeries.filter((x) => Number.isFinite(x));

  let estimated = true;
  let silverFut, prevClose, oi, oiChg, atmIv, ivRank, chain;
  if (realMcx && realMcx.silverFut != null) {
    estimated = false;
    silverFut = realMcx.silverFut;
    prevClose = realMcx.prevClose;
    oi = realMcx.oi;
    oiChg = realMcx.oiChg;
    chain = realMcx.chain ?? [];
    atmIv = rv20; // refine with Black-76 from chain if option prices present
    ivRank = rv20 != null && rvClean.length ? rangeRank(rv20, rvClean.concat(rv20)) : null;
  } else {
    // Parity estimate.
    silverFut = fairValue != null ? Math.round(fairValue) : null;
    prevClose = xagHistory.length > 1 ? Math.round(xagHistory[xagHistory.length - 2].v * PARITY_MULT * usdInr) : null;
    oi = null;
    oiChg = null;
    chain = [];
    atmIv = rv20 != null ? round(rv20 * 1.05, 4) : null; // options usually a touch above realized
    ivRank = rv20 != null && rvClean.length ? round(rangeRank(rv20, rvClean.concat(rv20)), 1) : null;
  }

  const expectedMove1sd = atmIv != null && silverFut != null ? Math.round(silverFut * atmIv * Math.sqrt(t)) : null;
  const basis = silverFut != null && fairValue != null ? Math.round(silverFut - fairValue) : null;

  const snapshot = {
    asOf: new Date().toISOString(),
    stale: false,
    partial: dxy == null || real10y == null,
    estimated,
    live: {
      xagUsd: round(xagUsd, 2),
      xauUsd: round(xauUsd, 2),
      usdInr: round(usdInr, 3),
      dxy: round(dxy, 2),
      real10y: round(real10y, 2),
      breakeven10y,
      xagHistory,
      xauHistory,
      dxyHistory,
      real10yHistory,
      usdInrHistory,
      asOf: new Date().toISOString(),
      partial: dxy == null,
    },
    mcx: {
      symbol: MCX_SYMBOL,
      silverFut,
      prevClose,
      expiry: expiryIso,
      dte,
      oi,
      oiChg,
    },
    options: {
      atmStrike: silverFut != null ? Math.round(silverFut / 1000) * 1000 : null,
      atmIv,
      ivRank,
      ivPercentile: ivRank,
      rv20: round(rv20, 4),
      expectedMove1sd,
      chain,
    },
    basis: { fairValue: round(fairValue, 0), basis },
    events: prev?.events?.length ? prev.events : builtinEvents(),
  };

  await writeFile(LATEST, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(
    `Wrote snapshot: xag=${xagUsd} inr=${usdInr} mcx=${silverFut} (${estimated ? "parity-est" : "live"}) ` +
      `iv=${atmIv} ivRank=${ivRank} dte=${dte} histLen=${xagHistory.length}`,
  );
}

main().catch((e) => {
  console.error("build-data failed:", e);
  process.exit(1);
});
