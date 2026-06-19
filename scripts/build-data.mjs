#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Sliver Screener — MCX data builder (runs in GitHub Actions during market
// hours). Produces public/data/latest.json and appends public/data/history.jsonl.
//
// Design goals:
//   * $0, no paid deps.
//   * FAIL SOFT: if the MCX source can't be refreshed, keep the last-good
//     snapshot and mark it `stale: true` rather than emitting bad/blank data.
//   * Everything downstream (IV, IV-rank, expected move, basis) is computed
//     here from raw inputs so the browser stays a thin renderer.
//
// MCX integration point: `fetchMcxRaw()` below. Two supported paths:
//   (A) Token-free NSE/MCX daily Bhavcopy  (primary — no daily login)
//   (B) Kite Connect quotes  (optional, richer/live — needs KITE_* secrets;
//       note the access token expires daily, so (A) is the reliable default)
// Wire whichever your data source supports; the rest of the pipeline is ready.
// ---------------------------------------------------------------------------

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toRaw } from "./bhavcopy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../public/data");
const LATEST = resolve(DATA_DIR, "latest.json");
const HISTORY = resolve(DATA_DIR, "history.jsonl");

const TROY_OZ_PER_KG = 32.1507;
const IMPORT_DUTY = 0.1075;
const GST = 0.03;

// --- math: Black-76 implied vol -------------------------------------------
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
function black76(F, K, t, vol, type) {
  if (t <= 0 || vol <= 0) return type === "CE" ? Math.max(F - K, 0) : Math.max(K - F, 0);
  const s = vol * Math.sqrt(t);
  const d1 = (Math.log(F / K) + (vol * vol) / 2 * t) / s;
  const d2 = d1 - s;
  return type === "CE" ? F * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - F * normCdf(-d1);
}
function impliedVol(price, F, K, t, type) {
  if (!(price > 0) || t <= 0) return null;
  let lo = 0.001, hi = 5;
  let flo = black76(F, K, t, lo, type) - price;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const fmid = black76(F, K, t, mid, type) - price;
    if (Math.abs(fmid) < 1e-3) return mid;
    if (Math.sign(fmid) === Math.sign(flo)) { lo = mid; flo = fmid; } else { hi = mid; }
  }
  return null;
}
function std(xs) {
  if (xs.length < 2) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function rangeRank(v, sample) {
  if (!sample.length) return null;
  const lo = Math.min(...sample), hi = Math.max(...sample);
  return hi === lo ? 50 : Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
}
function percentRank(v, sample) {
  if (!sample.length) return null;
  return (sample.filter((x) => x <= v).length / sample.length) * 100;
}

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// --- live spot / FX (server-side, same free sources as the browser) --------
async function fetchSpotFx() {
  const out = { xagUsd: null, usdInr: null };
  try {
    const ag = await getJson("https://api.gold-api.com/price/XAG");
    out.xagUsd = ag.price ?? null;
  } catch {}
  try {
    const fx = await getJson("https://api.frankfurter.app/latest?from=USD&to=INR");
    out.usdInr = fx.rates?.INR ?? null;
  } catch {}
  return out;
}

// ---------------------------------------------------------------------------
// MCX integration — token-free daily Bhavcopy via the public market-data
// endpoint. Returns the raw shape consumed by main(), or null on failure
// (which triggers the fail-soft path that preserves the last-good snapshot).
// ---------------------------------------------------------------------------

const MCX_BHAVCOPY_URL = "https://www.mcxindia.com/backpage.aspx/GetDateWiseBhavCopy";
const MCX_SYMBOL = (process.env.MCX_SYMBOL || "SILVER").toUpperCase();

// Browser-like headers — the endpoint rejects bare/botty requests.
const MCX_HEADERS = {
  "Content-Type": "application/json; charset=UTF-8",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Referer: "https://www.mcxindia.com/market-data/bhavcopy",
  Origin: "https://www.mcxindia.com",
};

/** Recent candidate trading days (today backwards), skipping weekends. */
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

// MCX is fronted by bot protection that expects cookies from a prior page
// visit. We prime once (GET the bhavcopy page) and reuse the Set-Cookie value
// on every POST. Best-effort: an empty cookie still attempts the request.
let cookieJar = "";
async function primeCookies() {
  try {
    const res = await fetch("https://www.mcxindia.com/market-data/bhavcopy", {
      headers: { "User-Agent": MCX_HEADERS["User-Agent"], Accept: "text/html" },
    });
    const cookies = res.headers.getSetCookie?.() ?? [];
    cookieJar = cookies.map((c) => c.split(";")[0]).join("; ");
    console.log(cookieJar ? "Primed MCX session cookies." : "No cookies returned by MCX.");
  } catch (e) {
    console.warn(`Cookie prime failed: ${e.message}`);
  }
}

/** Fetch + unwrap the bhavcopy rows for a single ISO date. */
async function fetchBhavRows(dateIso) {
  const [y, m, d] = dateIso.split("-");
  // The endpoint expects a US-style MM/DD/YYYY date string.
  const res = await fetch(MCX_BHAVCOPY_URL, {
    method: "POST",
    headers: cookieJar ? { ...MCX_HEADERS, Cookie: cookieJar } : MCX_HEADERS,
    body: JSON.stringify({ Date: `${m}/${d}/${y}` }),
  });
  if (!res.ok) throw new Error(`bhavcopy ${dateIso} -> ${res.status}`);
  const j = await res.json();
  let payload = j?.d ?? j;
  if (typeof payload === "string") payload = JSON.parse(payload);
  const rows = payload?.Data ?? payload?.data ?? payload;
  return Array.isArray(rows) ? rows : [];
}

/** Walk back day-by-day until a non-empty bhavcopy is found. */
async function firstNonEmptyBhav(dates) {
  for (const iso of dates) {
    try {
      const rows = await fetchBhavRows(iso);
      if (rows.length) return { iso, rows };
    } catch (e) {
      console.warn(`  bhavcopy ${iso}: ${e.message}`);
    }
  }
  return null;
}

async function fetchMcxRaw() {
  const today = new Date().toISOString().slice(0, 10);
  await primeCookies();
  const current = await firstNonEmptyBhav(recentTradingDays(6));
  if (!current) {
    console.warn("MCX bhavcopy unavailable for all recent days.");
    return null;
  }
  // Previous trading day (for OI change). Best-effort; null oiChg if missing.
  const prevStart = new Date(current.iso);
  prevStart.setUTCDate(prevStart.getUTCDate() - 1);
  const previous = await firstNonEmptyBhav(recentTradingDays(5, prevStart));

  const raw = toRaw(current.rows, MCX_SYMBOL, today, previous?.rows ?? null);
  if (!raw) console.warn(`No ${MCX_SYMBOL} future found in bhavcopy ${current.iso}.`);
  return raw;
}

function daysTo(iso) {
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));
}

function nearestAtm(chain, fut) {
  if (!chain?.length || !fut) return null;
  return chain.reduce((best, o) =>
    Math.abs(o.strike - fut) < Math.abs(best.strike - fut) ? o : best,
  );
}

async function loadLatest() {
  try {
    return JSON.parse(await readFile(LATEST, "utf8"));
  } catch {
    return null;
  }
}

async function loadHistory() {
  if (!existsSync(HISTORY)) return [];
  const txt = await readFile(HISTORY, "utf8");
  return txt
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const prev = await loadLatest();
  const history = await loadHistory();

  const raw = await fetchMcxRaw();

  if (!raw || raw.silverFut == null) {
    // Fail soft: preserve last-good, mark stale.
    if (prev) {
      const stale = { ...prev, stale: true, asOf: prev.asOf };
      await writeFile(LATEST, JSON.stringify(stale, null, 2) + "\n");
      console.warn("No fresh MCX data; preserved last-good snapshot as stale.");
    } else {
      console.warn("No MCX data and no prior snapshot; leaving seed file untouched.");
    }
    return;
  }

  const { xagUsd, usdInr } = await fetchSpotFx();
  const dte = daysTo(raw.expiry);
  const t = dte != null ? dte / 365 : null;

  // ATM IV from the nearest-strike option price.
  const atm = nearestAtm(raw.chain, raw.silverFut);
  let atmIv = null;
  if (atm && t) atmIv = impliedVol(atm.ltp, raw.silverFut, atm.strike, t, atm.type);

  // Per-strike IV for the chain.
  const chain = (raw.chain ?? []).map((o) => ({
    ...o,
    iv: t ? impliedVol(o.ltp, raw.silverFut, o.strike, t, o.type) : null,
  }));

  // Realized vol from futures history (close-to-close, last ~20 obs).
  const closes = history.map((h) => h.silverFut).filter((x) => Number.isFinite(x)).slice(-20);
  closes.push(raw.silverFut);
  const rets = [];
  for (let i = 1; i < closes.length; i++)
    if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  const rv20 = rets.length >= 5 ? std(rets) * Math.sqrt(252) : null;

  // IV rank/percentile from the atmIv history.
  const ivHist = history.map((h) => h.atmIv).filter((x) => Number.isFinite(x));
  const ivRank = atmIv != null ? rangeRank(atmIv, ivHist.concat(atmIv)) : null;
  const ivPercentile = atmIv != null ? percentRank(atmIv, ivHist.concat(atmIv)) : null;

  const expectedMove1sd = atmIv != null && t ? raw.silverFut * atmIv * Math.sqrt(t) : null;

  const fairValue =
    xagUsd != null && usdInr != null
      ? xagUsd * TROY_OZ_PER_KG * usdInr * (1 + IMPORT_DUTY + GST)
      : null;
  const basis = fairValue != null ? raw.silverFut - fairValue : null;

  const events = prev?.events ?? [];

  const snapshot = {
    asOf: new Date().toISOString(),
    stale: false,
    partial: xagUsd == null || usdInr == null,
    mcx: {
      symbol: raw.symbol ?? "SILVER",
      silverFut: raw.silverFut,
      prevClose: raw.prevClose ?? null,
      expiry: raw.expiry ?? null,
      dte,
      oi: raw.oi ?? null,
      oiChg: raw.oiChg ?? null,
    },
    options: {
      atmStrike: atm?.strike ?? null,
      atmIv: round(atmIv, 4),
      ivRank: round(ivRank, 1),
      ivPercentile: round(ivPercentile, 1),
      rv20: round(rv20, 4),
      expectedMove1sd: round(expectedMove1sd, 0),
      chain,
    },
    basis: { fairValue: round(fairValue, 0), basis: round(basis, 0) },
    events,
  };

  await writeFile(LATEST, JSON.stringify(snapshot, null, 2) + "\n");
  await appendFile(
    HISTORY,
    JSON.stringify({
      t: snapshot.asOf,
      silverFut: raw.silverFut,
      atmIv: round(atmIv, 4),
      oi: raw.oi ?? null,
    }) + "\n",
  );
  console.log(`Wrote snapshot: fut=${raw.silverFut} atmIv=${atmIv} ivRank=${snapshot.options.ivRank}`);
}

function round(x, d) {
  if (x == null || !Number.isFinite(x)) return null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

main().catch((e) => {
  console.error("build-data failed:", e);
  process.exit(1);
});
