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
//   * Upstox (MCX)         -> real future/options for the metal being built
//
// When MCX exchange data is unavailable, MCX price is computed from import
// parity and IV is estimated from realized vol — the snapshot is flagged
// `estimated:true` so the UI labels it. Always fails soft to last-good.
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toRaw } from "./bhavcopy.mjs";
import * as upstox from "./upstox.mjs";
import {
  METALS,
  METAL_IDS,
  DEFAULT_METAL,
  parityMult,
  strikeStep,
  allContractSymbols,
} from "../src/lib/metals.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../public/data");
const LATEST = resolve(DATA_DIR, "latest.json");

// Which metals this run builds. Defaults to all of them; set METALS_ONLY to a
// comma-separated list (e.g. "silver,gold") to narrow a debugging run.
// The parity constants (oz/kg, duty, GST) used to be duplicated here and in
// src/lib/basis.ts and kept in sync by hand; they now come from the shared
// registry so client and builder cannot disagree.
const BUILD_METALS = (process.env.METALS_ONLY || METAL_IDS.join(","))
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter((x) => METAL_IDS.includes(x));
// Every contract symbol the registry knows — passed to the instrument matcher
// so a longer relative (SILVERMIC vs SILVERM) never leaks into this chain.
const CONTRACT_SYMBOLS = allContractSymbols();

// --- small stats -----------------------------------------------------------
/** Newest value of a {t,v} series, or null when empty. */
const last = (h) => (h && h.length ? h[h.length - 1].v : null);

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

// Twelve Data — key-authenticated (not IP-blocked like keyless APIs). Free tier
// covers XAG/USD, XAU/USD, USD/INR, DXY. Set TWELVEDATA_KEY as a repo secret.
async function twelveDataHistory(symbol, n = 160) {
  const key = process.env.TWELVEDATA_KEY;
  if (!key) return [];
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${n}&order=ASC&apikey=${key}`;
  try {
    const j = await getJson(url);
    if (j.status === "error" || !Array.isArray(j.values)) {
      console.warn(`td ${symbol}: ${j.message || "no values"}`);
      return [];
    }
    return j.values
      .map((v) => ({ t: v.datetime, v: Number(v.close) }))
      .filter((p) => Number.isFinite(p.v) && p.v > 0);
  } catch (e) {
    console.warn(`td ${symbol}: ${e.message}`);
    return [];
  }
}

// Fetch a daily series, trying providers in order until one returns data:
// Twelve Data (key, multiple symbol aliases) -> Yahoo (keyless) -> stooq.
async function fetchSeries(name, { td, yahoo, stooq }) {
  for (const sym of Array.isArray(td) ? td : [td]) {
    const h = await twelveDataHistory(sym);
    if (h.length > 5) {
      console.log(`${name}: td ${sym} ${h.length} pts`);
      return h;
    }
  }
  let h = await yahooHistory(yahoo);
  if (h.length > 5) {
    console.log(`${name}: yahoo ${h.length} pts`);
    return h;
  }
  h = await stooqHistory(stooq);
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

// --- CFTC Commitments of Traders (weekly speculative positioning) ---------
// Free Socrata JSON API. Managed-money net (disaggregated) preferred; legacy
// non-commercial net as fallback. Contract codes come from the registry
// (silver 084691, gold 088691, copper 085692) — same endpoint, same shape.
async function fetchCot(contractCode) {
  const sources = [
    { id: "72hh-3qpy", long: "m_money_positions_long_all", short: "m_money_positions_short_all", label: "managed money" },
    { id: "6dca-aqww", long: "noncomm_positions_long_all", short: "noncomm_positions_short_all", label: "non-commercial" },
  ];
  for (const s of sources) {
    try {
      const q = `cftc_contract_market_code=${contractCode}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=170`;
      const url = `https://publicreporting.cftc.gov/resource/${s.id}.json?${q}`;
      const j = await getJson(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } });
      if (!Array.isArray(j) || !j.length) {
        console.warn(`cot ${contractCode}/${s.id}: empty`);
        continue;
      }
      const rows = j
        .map((r) => ({
          t: String(r.report_date_as_yyyy_mm_dd || "").slice(0, 10),
          net: Number(r[s.long]) - Number(r[s.short]),
        }))
        .filter((r) => r.t && Number.isFinite(r.net))
        .reverse();
      if (rows.length < 6) continue;
      const nets = rows.map((r) => r.net);
      const latest = nets[nets.length - 1];
      const below = nets.filter((x) => x <= latest).length;
      const percentile = Math.round((below / nets.length) * 100);
      console.log(`cot ${contractCode}: ${s.label} net=${latest} pctile=${percentile} n=${rows.length} asOf=${rows[rows.length - 1].t}`);
      return {
        net: Math.round(latest),
        percentile,
        asOf: rows[rows.length - 1].t,
        source: s.label,
        history: rows.slice(-78).map((r) => ({ t: r.t, v: Math.round(r.net) })),
      };
    } catch (e) {
      console.warn(`cot ${contractCode}/${s.id}: ${e.message}`);
    }
  }
  return null;
}

// --- Recent macro prints (FRED) — "what actually happened" for the radar ----
// CPI YoY, monthly payrolls change, Fed target rate: the three US prints that
// move silver hardest, each with the prior reading + a silver-impact read.
async function fetchEconPrints() {
  if (!process.env.FRED_KEY) return [];
  const [cpi, payems, fed] = await Promise.all([
    fredSeries("CPIAUCSL"), // CPI index, monthly SA
    fredSeries("PAYEMS"), // total nonfarm payrolls, thousands
    fredSeries("DFEDTARU"), // Fed funds target upper bound, daily
  ]);
  const prints = [];
  const monthOf = (t) => new Date(t + "T00:00:00Z").toLocaleString("en", { month: "short", year: "2-digit", timeZone: "UTC" });

  if (cpi.length >= 14) {
    const yoy = (i) => (cpi[i].v / cpi[i - 12].v - 1) * 100;
    const a = yoy(cpi.length - 1);
    const p = yoy(cpi.length - 2);
    const cooling = a < p - 0.01;
    const hot = a > p + 0.01;
    prints.push({
      kind: "us_cpi", name: "US CPI (YoY)", period: monthOf(cpi[cpi.length - 1].t),
      actual: round(a, 1), prior: round(p, 1), unit: "%",
      impact: cooling ? "up" : hot ? "down" : "twoway",
      note: cooling
        ? "Inflation cooled vs the prior month → rate-cut hopes build → supportive for silver."
        : hot
          ? "Inflation ran hotter → cuts get pushed out, real yields firm → a silver headwind."
          : "Inflation flat vs prior — little new pressure either way.",
    });
  }
  if (payems.length >= 3) {
    const a = payems[payems.length - 1].v - payems[payems.length - 2].v;
    const p = payems[payems.length - 2].v - payems[payems.length - 3].v;
    const weak = a < p - 10;
    const strong = a > p + 10;
    prints.push({
      kind: "us_jobs", name: "US payrolls (chg)", period: monthOf(payems[payems.length - 1].t),
      actual: Math.round(a), prior: Math.round(p), unit: "k",
      impact: weak ? "up" : strong ? "down" : "twoway",
      note: weak
        ? "Job growth slowed vs prior → dovish tilt → silver supportive."
        : strong
          ? "Jobs came in stronger → hawkish risk, USD/yields firm → silver headwind."
          : "Payrolls roughly in line with the prior month.",
    });
  }
  if (fed.length >= 2) {
    const cur = fed[fed.length - 1].v;
    let i = fed.length - 1;
    while (i > 0 && fed[i - 1].v === cur) i--;
    const prevRate = i > 0 ? fed[i - 1].v : cur;
    const changedAt = fed[i]?.t ?? fed[fed.length - 1].t;
    const cutLast = prevRate > cur;
    const hikeLast = prevRate < cur;
    prints.push({
      kind: "fomc", name: "Fed target rate", period: monthOf(changedAt),
      actual: round(cur, 2), prior: round(prevRate, 2), unit: "%",
      impact: cutLast ? "up" : hikeLast ? "down" : "twoway",
      note: cutLast
        ? `Last move was a CUT (${prevRate}% → ${cur}%) — easing bias supports silver.`
        : hikeLast
          ? `Last move was a HIKE (${prevRate}% → ${cur}%) — tightening pressures silver.`
          : `On hold at ${cur}% — watch the next FOMC for the turn.`,
    });
  }
  console.log(`prints: ${prints.length} recent macro prints`);
  return prints;
}

// --- News (Google News RSS, silver-relevant, keyword-tagged impact) --------
function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}
const BULL_KW = [/rate cut/i, /dovish/i, /weaker dollar/i, /dollar (falls|drops|weakens|slips)/i, /inflation/i, /safe[- ]?haven/i, /deficit/i, /shortage/i, /squeeze/i, /supply (crunch|tight|deficit)/i, /record high/i, /rally|rallies|surge|soar|jump|spike/i, /solar/i, /import dut|tariff/i, /geopolit|war|conflict|tension/i, /stimulus/i, /yields? (fall|drop|ease)/i, /buying|inflows/i, /bull/i];
const BEAR_KW = [/rate hike/i, /hawkish/i, /stronger dollar/i, /dollar (rises|gains|strengthens|jumps)/i, /yields? (rise|jump|climb)/i, /(strong|robust|hot) jobs|jobs beat/i, /sell[- ]?off/i, /plunge|plummet|tumble|slump|crash|sink/i, /(falls|drops|slips|declines|slides)/i, /glut|oversupply|surplus/i, /profit[- ]?taking/i, /correction/i, /demand (cut|weak|soft|slump)/i, /outflows/i, /bear/i];
function tagImpact(text) {
  let b = 0, r = 0;
  for (const re of BULL_KW) if (re.test(text)) b++;
  for (const re of BEAR_KW) if (re.test(text)) r++;
  return b > r ? "up" : r > b ? "down" : "twoway";
}
// Reputable outlets the user trusts. Trusted items rank first; others only fill
// leftover slots. Matching is against the RSS <source> name.
const TRUSTED_SOURCES = [
  /reuters/i, /bloomberg/i, /zee\s*business/i, /economic times/i, /livemint|^mint$|\bmint\b/i,
  /moneycontrol/i, /business standard/i, /ndtv profit/i, /cnbc/i, /kitco/i,
  /financial express/i, /businessline|hindu business/i, /forbes/i, /cme group/i,
  /marketwatch/i, /wall street journal|wsj/i, /financial times/i, /investing\.com/i,
];
const isTrusted = (source) => TRUSTED_SOURCES.some((re) => re.test(source || ""));
async function fetchNews(prevNews, metal) {
  const n = metal.news;
  const rss = (q, region) =>
    `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-${region}&gl=${region}&ceid=${region}:en`;
  const queries = [
    rss(n.query, "IN"),
    rss(n.forecastQuery, "US"),
    // Targeted pull from the most-trusted outlets so they're well represented.
    rss(
      `${n.trustedSubject} (source:Reuters OR source:Bloomberg OR source:"Zee Business" OR source:"The Economic Times" OR source:Mint)`,
      "IN",
    ),
    // Indirect drivers. These differ completely by metal: bullion follows the
    // Fed and the dollar, copper follows China, inventories and tariffs.
    rss(n.indirectQuery, "US"),
  ];
  // Freshness: nothing older than ~2.5 weeks makes the feed.
  const MAX_AGE_MS = 18 * 86400000;
  const cutoff = Date.now() - MAX_AGE_MS;
  // Direct = names the metal itself; indirect = a driver that moves it.
  const DIRECT_RE = new RegExp(n.directPattern, "i");
  const INDIRECT_RE = new RegExp(n.indirectPattern, "i");
  const items = [];
  const seen = new Set();
  for (const url of queries) {
    try {
      const xml = await getText(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/rss+xml,application/xml" } });
      for (const block of xml.split("<item>").slice(1)) {
        const get = (tag) => {
          const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
          return m ? m[1] : "";
        };
        let title = decodeEntities(stripTags(get("title")));
        const link = decodeEntities(stripTags(get("link")));
        const pub = get("pubDate");
        const desc = decodeEntities(stripTags(get("description")));
        const srcM = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
        let source = srcM ? decodeEntities(stripTags(srcM[1])) : "";
        if (!source && / - [^-]{2,40}$/.test(title)) {
          const i = title.lastIndexOf(" - ");
          source = title.slice(i + 3);
          title = title.slice(0, i);
        } else if (source && title.endsWith(" - " + source)) {
          title = title.slice(0, -(source.length + 3));
        }
        if (!title || !link) continue;
        const pubMs = pub ? new Date(pub).getTime() : Date.now();
        if (Number.isFinite(pubMs) && pubMs < cutoff) continue; // too old
        const text = `${title} ${desc}`;
        const direct = DIRECT_RE.test(text);
        if (!direct && !INDIRECT_RE.test(text)) continue;
        const key = title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          title,
          url: link,
          source: source || "News",
          trusted: isTrusted(source),
          indirect: !direct,
          publishedAt: new Date(Number.isFinite(pubMs) ? pubMs : Date.now()).toISOString(),
          snippet: desc.slice(0, 200),
          impact: tagImpact(text),
        });
      }
    } catch (e) {
      console.warn(`news ${url.slice(0, 48)}: ${e.message}`);
    }
  }
  items.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  // Trusted outlets first (newest-first within each group); others only fill
  // whatever slots remain. Cap indirect/macro items so silver stays the focus.
  const MAX_INDIRECT = 6;
  let indirectCount = 0;
  const pick = (list, acc) => {
    for (const i of list) {
      if (acc.length >= 15) break;
      if (i.indirect) {
        if (indirectCount >= MAX_INDIRECT) continue;
        indirectCount++;
      }
      acc.push(i);
    }
    return acc;
  };
  const out = pick(items.filter((i) => !i.trusted), pick(items.filter((i) => i.trusted), []));
  console.log(`news: ${out.length} items (${out.filter((i) => i.trusted).length} trusted, ${indirectCount} indirect)`);
  // NOTE: hook point — if a NEWS_AI_KEY is configured, an LLM could rewrite
  // `snippet`/`impact` per item here (cache by url to stay cheap). Rule-based for now.
  // Fallback to last-good news, but never resurrect stale items past the cutoff.
  const prevFresh = (prevNews ?? []).filter((n) => new Date(n.publishedAt).getTime() >= cutoff);
  return out.length ? out : prevFresh;
}

/** Append/replace today's point with a fresher live value. */
function withLatest(hist, value) {
  if (value == null || !Number.isFinite(value)) return hist;
  const today = new Date().toISOString().slice(0, 10);
  const filtered = hist.filter((p) => p.t !== today);
  return [...filtered, { t: today, v: value }];
}

/** Union of date-keyed series (later lists win on conflict), sorted ascending. */
function mergeByDate(...lists) {
  const m = new Map();
  for (const list of lists) for (const p of list || []) if (p && p.t && Number.isFinite(p.v)) m.set(p.t, p.v);
  return [...m.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
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
      if (rows.length) return toRaw(rows, METALS[DEFAULT_METAL].feedSymbol, today, null);
    } catch (e) {
      console.warn(`  ${e.message}`);
    }
  }
  return null;
}

/**
 * Real MCX data via Upstox (read-only Analytics token). Returns null when no
 * token / unavailable. `usdInr` is used to express the MCX silver future as an
 * implied $/oz history for the directional engine.
 */
// ATM IV from chain greeks (avg of the nearest-strike CE/PE that report IV).
function atmIvFromChain(rows, ref) {
  if (!rows.length) return null;
  const k = rows.reduce((b, o) => (Math.abs(o.strike - ref) < Math.abs(b - ref) ? o.strike : b), rows[0].strike);
  const ivs = rows.filter((o) => o.strike === k && o.iv != null).map((o) => o.iv);
  return ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
}

/**
 * Build a raw per-expiry bundle (price / OI / option chain / ATM IV) for one
 * contract month. Best-effort — returns null when the future has no usable
 * price. Far months may have thin/empty chains; that's surfaced downstream.
 */
async function buildRawBundle(metal, token, c, usdInr, from, today) {
  const [{ history: futHist, oiHistory }, q, chainRaw] = await Promise.all([
    upstox.dailyCandles(token, c.future.key, from, today),
    upstox.quote(token, c.future.key),
    upstox.optionChain(token, c.future.key, c.optionExpiry),
  ]);
  const qd = Object.values(q)[0] ?? {};
  const ltp = Number(qd.last_price) || (futHist.length ? futHist[futHist.length - 1].v : NaN);
  if (!Number.isFinite(ltp) || ltp <= 0) return null;
  const oi = Number(qd.oi) || (oiHistory.length ? oiHistory[oiHistory.length - 1].v : null);
  const prevClose = futHist.length > 1 ? futHist[futHist.length - 2].v : Number(qd.ohlc?.close) || null;
  const oiChg = oiHistory.length > 1 && oi != null ? oi - oiHistory[oiHistory.length - 2].v : null;

  // ATM IV: chain greeks first; else solve Black-76 from real option LTPs so IV
  // stays a TRADED number, not a realized-vol proxy.
  let chain = chainRaw;
  let atmIv = atmIvFromChain(chain, ltp);
  if (atmIv == null && c.options?.length) {
    const fb = await upstox.ivFromOptionQuotes(token, c.options, ltp, c.optionExpiry);
    if (fb.atmIv != null) atmIv = fb.atmIv;
    if ((!chain || !chain.length) && fb.chain.length) chain = fb.chain;
  }

  const dte = Math.max(0, Math.ceil((new Date(c.expiry).getTime() - Date.now()) / 86400000));
  const optionDte = Math.max(0, Math.ceil((new Date(c.optionExpiry).getTime() - Date.now()) / 86400000));
  // MCX future (₹/quote-unit) -> implied international price, so the engine
  // sees the metal's own traded momentum rather than a spot proxy.
  const mult = parityMult(metal) * (usdInr || 1);
  const metalUsdHistory = mult > 0 ? futHist.map((p) => ({ t: p.t, v: p.v / mult })) : [];
  return {
    expiry: c.expiry, optionExpiry: c.optionExpiry, dte, optionDte,
    fut: Math.round(ltp), prevClose, oi, oiChg, atmIv, chain,
    metalUsdHistory, futHistLen: futHist.length,
  };
}

/**
 * Live MCX data for one metal. `instruments` is the shared MCX master, fetched
 * once per run and passed in — it is ~all of MCX, so re-downloading it per
 * metal would triple the largest fetch in the pipeline for no new data.
 */
async function fetchUpstox(metal, usdInr, instruments) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) return null;
  const symbol = metal.feedSymbol;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
    // All upcoming monthly option expiries (nearest first) + their futures.
    const contracts = upstox.pickChainContracts(instruments, symbol, today, 4, CONTRACT_SYMBOLS);
    if (!contracts.length) {
      const sample = instruments
        .filter((i) => JSON.stringify(i).toUpperCase().includes(metal.family))
        .slice(0, 4)
        .map((i) => ({ name: i.name, ts: i.trading_symbol, it: i.instrument_type, us: i.underlying_symbol, ot: i.option_type }));
      console.warn(`upstox: no ${symbol} contracts. ${metal.family} samples: ${JSON.stringify(sample)}`);
      return null;
    }
    const bundles = [];
    for (const c of contracts) {
      try {
        const b = await buildRawBundle(metal, token, c, usdInr, from, today);
        if (b) bundles.push(b);
      } catch (e) {
        console.warn(`upstox ${symbol} bundle ${c.optionExpiry}: ${e.message}`);
      }
    }
    const near = bundles[0];
    if (!near || near.futHistLen < 5) {
      console.warn(`upstox ${symbol}: no usable nearest bundle (thin futures history)`);
      return null;
    }
    console.log(
      `upstox: ${symbol} ${bundles.length} expiries [` +
        bundles.map((b) => `${b.optionExpiry}:fut${b.fut}/oi${b.oi}/ch${b.chain.length}`).join(", ") +
        `] atmIv=${near.atmIv}`,
    );
    return {
      fut: near.fut, prevClose: near.prevClose, oi: near.oi, oiChg: near.oiChg,
      expiry: near.expiry, optionExpiry: near.optionExpiry,
      optionExpiries: contracts.map((c) => c.optionExpiry),
      dte: near.dte, optionDte: near.optionDte, atmIv: near.atmIv, chain: near.chain,
      metalUsdHistory: near.metalUsdHistory, expiries: bundles,
    };
  } catch (e) {
    console.warn(`upstox ${symbol} failed: ${e.message}`);
    return null;
  }
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

/** Upcoming calendar: FOMC decision days (2026 schedule), NFP (first Friday,
 *  computed), CPI (release ≈ mid-month, date approximate), + MCX option expiry. */
function buildEvents(optionExpiryIso) {
  const FOMC = ["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"];
  const CPI = ["2026-07-10", "2026-08-12", "2026-09-11", "2026-10-13", "2026-11-12", "2026-12-10"];
  const events = [];
  for (const d of FOMC) events.push({
    name: "Fed FOMC", date: d, kind: "fomc", impact: "twoway", weight: 3,
    effect: "Dovish / cut → silver UP. Hawkish hold → silver DOWN. Biggest IV-crush event.",
  });
  for (const d of CPI) events.push({
    name: "US CPI", date: d, kind: "us_cpi", impact: "twoway", weight: 3,
    effect: "Hot CPI → cuts fade, real yields up → silver DOWN. Cool CPI → silver UP. (Release date approximate.)",
  });
  // NFP: first Friday of this month + next 3.
  const now = new Date();
  for (let k = 0; k < 4; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
    while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
    events.push({
      name: "US Jobs (NFP)", date: d.toISOString().slice(0, 10), kind: "us_jobs", impact: "twoway", weight: 2,
      effect: "Hot payrolls → hawkish Fed, ↑ yields & USD → silver DOWN. Weak jobs → silver UP.",
    });
  }
  if (optionExpiryIso) events.push({
    name: "MCX option expiry", date: optionExpiryIso, kind: "mcx_expiry", impact: "twoway", weight: 2,
    effect: "Theta collapse + pin risk near big-OI strikes. Roll or close short options before the final days.",
  });
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 75 * 86400000).toISOString().slice(0, 10);
  return events
    .filter((e) => e.date >= today && e.date <= horizon)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, 8);
}

/**
 * Gamma-exposure (GEX) read from the option chain — is the market PINNING
 * (dealers long gamma, price gets dampened toward big strikes) or prone to
 * RANGING/trending moves? Black-76 gamma × OI per strike, calls signed +,
 * puts − (standard dealers-long-calls/short-puts convention). EXPERIMENTAL:
 * MCX OI is thin and the dealer assumption is crude — treat as a lean.
 */
function computeGex(chain, F, tYears) {
  const rows = (chain || []).filter((o) => o.iv != null && o.iv > 0 && o.oi > 0 && o.strike > 0);
  if (!(F > 0) || !(tYears > 0) || rows.length < 4) return null;
  const perStrike = new Map();
  let callG = 0, putG = 0;
  for (const o of rows) {
    const sT = o.iv * Math.sqrt(tYears);
    const d1 = (Math.log(F / o.strike) + ((o.iv * o.iv) / 2) * tYears) / sT;
    const gamma = Math.exp(-(d1 * d1) / 2) / Math.sqrt(2 * Math.PI) / (F * sT);
    const g = gamma * o.oi;
    perStrike.set(o.strike, (perStrike.get(o.strike) ?? 0) + g);
    if (o.type === "CE") callG += g;
    else putG += g;
  }
  const tot = callG + putG;
  if (!(tot > 0)) return null;
  const netPct = Math.round(((callG - putG) / tot) * 100); // + = long-gamma tilt
  const regime = netPct >= 20 ? "pinning" : netPct <= -20 ? "volatile" : "balanced";
  const pinStrike = [...perStrike.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const strikes = [...new Set(rows.map((o) => o.strike))];
  let maxPain = strikes[0], best = Infinity;
  for (const s of strikes) {
    let pay = 0;
    for (const o of rows) pay += o.oi * (o.type === "CE" ? Math.max(0, s - o.strike) : Math.max(0, o.strike - s));
    if (pay < best) { best = pay; maxPain = s; }
  }
  const callWall = rows.filter((o) => o.type === "CE").sort((a, b) => b.oi - a.oi)[0]?.strike ?? null;
  const putWall = rows.filter((o) => o.type === "PE").sort((a, b) => b.oi - a.oi)[0]?.strike ?? null;
  return { netPct, regime, pinStrike, maxPain, callWall, putWall, coverage: rows.length };
}

// --- COMEX silver futures term structure (contango / backwardation) --------
// A lightweight "OpenBB-style" curve read, fetched from Yahoo (the same free
// source OpenBB wraps) — OpenBB itself has no MCX data, so we only borrow the
// international signal it's good at. Silver normally sits in mild CONTANGO
// (cost of carry); a flip toward BACKWARDATION signals physical tightness /
// squeeze risk — a genuine warning for short-call sellers. Best-effort: falls
// back to a front-future-vs-spot carry read, then to null (UI hides the card).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Upcoming liquid COMEX delivery months for a metal, nearest first. */
function nextComexContracts(metal, from = new Date(), n = 5) {
  const { root, months } = metal.comex;
  const out = [];
  const y0 = from.getUTCFullYear(), m0 = from.getUTCMonth();
  for (let i = 0; out.length < n && i < 24; i++) {
    const mi = (m0 + i) % 12;
    const yy = y0 + Math.floor((m0 + i) / 12);
    if (months[mi]) {
      out.push({
        sym: `${root}${months[mi]}${String(yy).slice(2)}.CMX`,
        label: `${MONTHS[mi]}'${String(yy).slice(2)}`,
        monthsOut: i + 0.5, // mid-delivery-month, in months from now
      });
    }
  }
  return out;
}

async function yahooQuote(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`;
  try {
    const j = await getJson(url, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0" } });
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch (e) {
    console.warn(`yahoo quote ${sym}: ${e.message}`);
    return null;
  }
}

function curveResult(front, annualizedPct, months, source) {
  if (annualizedPct == null || !Number.isFinite(annualizedPct)) return null;
  const structure = annualizedPct < -0.5 ? "backwardation" : annualizedPct > 1 ? "contango" : "flat";
  return { front: round(front, 2), structure, annualizedPct, months, source };
}

async function fetchCurve(metal, spotUsd) {
  const contracts = nextComexContracts(metal);
  const prices = await Promise.all(contracts.map((c) => yahooQuote(c.sym)));
  const months = contracts
    .map((c, i) => ({ label: c.label, monthsOut: c.monthsOut, price: prices[i] }))
    .filter((m) => m.price != null);

  if (months.length >= 2) {
    const near = months[0], far = months[months.length - 1];
    const dm = far.monthsOut - near.monthsOut;
    const annualizedPct = dm > 0 ? round((far.price / near.price - 1) * (12 / dm) * 100, 2) : null;
    console.log(`curve ${metal.id}: ${months.length} contracts, annualized ${annualizedPct}%`);
    return curveResult(near.price, annualizedPct, months.map((m) => ({ label: m.label, price: round(m.price, 2) })), "curve");
  }

  // Fallback: nearest listed future vs spot → a rough one-month carry read.
  const front = await yahooQuote(metal.comex.spot);
  if (front != null && spotUsd != null && spotUsd > 0) {
    const annualizedPct = round((front / spotUsd - 1) * 12 * 100, 2);
    console.log(`curve: carry fallback (front vs spot), annualized ${annualizedPct}%`);
    return curveResult(
      front,
      annualizedPct,
      [{ label: "Spot", price: round(spotUsd, 2) }, { label: "Front", price: round(front, 2) }],
      "carry",
    );
  }
  console.warn(`curve ${metal.id}: no futures data available`);
  return null;
}

// --- per-strike OI change vs yesterday's close --------------------------------
/** { [strike]: { CE: oi, PE: oi } } from a chain, for day-over-day OI diffing. */
function chainOiMap(chain) {
  const m = {};
  for (const o of chain || []) {
    if (!(o.strike > 0)) continue;
    (m[o.strike] ??= {})[o.type] = o.oi ?? 0;
  }
  return m;
}
/** Current calendar date in IST (MCX's timezone) — the "today" for OI change. */
function istToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Path of one metal's snapshot file. */
const metalFile = (id) => resolve(DATA_DIR, `${id}.json`);

/**
 * Previous snapshot for a metal. Falls back to latest.json for silver so the
 * very first multi-metal run inherits the accumulated history (real IV series,
 * silver price history, OI baselines) instead of starting from nothing.
 */
async function loadSnapshot(metalId) {
  for (const f of metalId === DEFAULT_METAL ? [metalFile(metalId), LATEST] : [metalFile(metalId)]) {
    try {
      return migrateLegacy(JSON.parse(await readFile(f, "utf8")));
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Read the pre-metals field names (`silverFut`, `xagUsd`, `xagHistory`).
 *
 * This is not cosmetic. The snapshot IS the pipeline's state store: it carries
 * the accumulated price history, the real ATM-IV series that IV rank needs ~20
 * days of, and the per-expiry OI baselines. On the first run after the rename,
 * reading the old file without this would silently find those keys missing and
 * start every accumulator from zero — throwing away months of history with no
 * error anywhere.
 */
function migrateLegacy(j) {
  if (!j || typeof j !== "object") return j;
  if (j.mcx && j.mcx.fut == null && j.mcx.silverFut != null) j.mcx.fut = j.mcx.silverFut;
  if (j.live) {
    if (j.live.metalUsd == null && j.live.xagUsd != null) j.live.metalUsd = j.live.xagUsd;
    if (!j.live.metalHistory?.length && j.live.xagHistory?.length) {
      j.live.metalHistory = j.live.xagHistory;
    }
  }
  for (const b of j.expiries ?? []) {
    if (b && b.fut == null && b.silverFut != null) b.fut = b.silverFut;
  }
  return j;
}

/**
 * Everything that is NOT metal-specific: the dollar, rates, the rupee, gold as
 * a cross-asset reference, and the US macro prints. Fetched ONCE per run and
 * handed to every metal — these are the same numbers whichever metal you are
 * looking at, and re-fetching them per metal would triple the request count
 * against the free tiers for no new information.
 */
async function fetchShared(prevShared) {
  const [xauH, dxyH, inrH, fredReal, fredNom, fredUsd] = await Promise.all([
    fetchSeries("xau", METALS.gold.intlFeeds),
    // Only the genuine dollar index — aliases like DX/USDX map to unrelated
    // tickers on Twelve Data, so we'd rather drop DXY than use bad data.
    fetchSeries("dxy", { td: ["DXY"], yahoo: "DX-Y.NYB", stooq: "^dxy" }),
    fetchSeries("usdinr", { td: ["USD/INR"], yahoo: "INR=X", stooq: "usdinr" }),
    fredSeries("DFII10"),
    fredSeries("DGS10"),
    // Dollar-index fallback: the Fed's daily Broad USD Index. Different scale
    // from ICE DXY (~120 vs ~97) but tracks its DIRECTION closely — and the
    // engine only uses dollar momentum, so direction is what matters. Never
    // IP-blocked (FRED), so this is the reliable source when DXY is unavailable.
    fredSeries("DTWEXBGS"),
  ]);

  const [xauSpot, inrSpot, prints] = await Promise.all([
    goldApi(METALS.gold.intlFeeds.goldApi),
    frankfurterInr(),
    fetchEconPrints(),
  ]);

  const prevLive = prevShared ?? {};
  const grow = (fetched, prevKey, spot) =>
    withLatest(fetched.length > 5 ? fetched : prevLive[prevKey] ?? [], spot);

  const xauHistory = grow(xauH, "xauHistory", xauSpot);
  const usdInrHistory = grow(inrH, "usdInrHistory", inrSpot);
  const dxyHistory = dxyH.length > 5 ? dxyH : fredUsd.length > 5 ? fredUsd : [];
  const usdBroad = !(dxyH.length > 5) && fredUsd.length > 5;

  const real10y = fredReal.length ? fredReal[fredReal.length - 1].v : null;
  const nominal10y = fredNom.length ? fredNom[fredNom.length - 1].v : null;

  return {
    xauHistory,
    usdInrHistory,
    dxyHistory,
    real10yHistory: fredReal,
    usdBroad,
    xauUsd: last(xauHistory),
    usdInr: last(usdInrHistory),
    dxy: last(dxyHistory),
    real10y,
    breakeven10y: nominal10y != null && real10y != null ? round(nominal10y - real10y, 2) : null,
    xauSpot,
    prints,
  };
}

/**
 * Build one metal's complete snapshot. Everything below was `main()` before the
 * three-metal split; the only structural change is that shared macro arrives as
 * a parameter instead of being fetched inline, and every silver constant now
 * comes from `metal`.
 */
async function buildMetal(metal, shared, prev, instruments) {
  const MCX_SYMBOL = metal.feedSymbol;
  const PARITY_MULT = parityMult(metal);

  // The metal's own international price history. Gold is already in `shared`
  // (it doubles as the cross-asset reference), so don't fetch it twice.
  const isGold = metal.id === "gold";
  const [metalH, metalSpot, cotNew, news] = await Promise.all([
    isGold ? Promise.resolve([]) : fetchSeries(metal.id, metal.intlFeeds),
    isGold
      ? Promise.resolve(shared.xauSpot)
      : metal.intlFeeds.goldApi
        ? goldApi(metal.intlFeeds.goldApi)
        : Promise.resolve(null),
    fetchCot(metal.cotCode),
    fetchNews(prev?.news, metal),
  ]);

  const { xauHistory, usdInrHistory, dxyHistory, real10yHistory, usdBroad, prints } = shared;

  // Use the fetched history when a provider returned a real series; otherwise
  // accumulate day-by-day from the live spot (persisted across runs) so the
  // metal builds a genuine history even though no free API serves it.
  const prevLive = prev?.live ?? {};
  function buildHistory(fetched, prevKey, spot) {
    const base = fetched.length > 5 ? fetched : prevLive[prevKey] ?? [];
    return withLatest(base, spot);
  }
  let metalHistory = isGold
    ? xauHistory
    : buildHistory(metalH, "metalHistory", metalSpot);
  const { xauUsd, usdInr, dxy, real10y, breakeven10y } = shared;

  // Publish when we have enough to drive the engine. The metal's own history is
  // ideal, but gold + USD-INR alone still yield a meaningful (if weaker) bias.
  const haveCore = metalHistory.length > 5 || (xauHistory.length > 5 && usdInrHistory.length > 5);
  if (!haveCore) {
    // Preserve this metal's own last-good rather than dropping it — one metal's
    // dead feed must never take the others down with it.
    console.warn(`${metal.id}: core history unavailable; ${prev ? "preserved last-good as stale" : "no prior snapshot"}.`);
    return prev ? { ...prev, stale: true } : null;
  }

  // MCX: real Upstox data (preferred) -> reuse last-good real -> parity.
  const ups = await fetchUpstox(metal, usdInr, instruments);
  const prevReal = prev && prev.estimated === false ? prev : null;

  // Persist silver history: union of prior real silver + Upstox silver + today's
  // spot, so a transient Upstox hiccup never wipes the accumulated real history.
  const realMetal = ups?.metalUsdHistory?.length ? ups.metalUsdHistory : prevReal?.live?.metalHistory ?? [];
  metalHistory = mergeByDate(prevLive.metalHistory ?? [], realMetal, [
    { t: new Date().toISOString().slice(0, 10), v: metalSpot },
  ]);

  const metalUsd = last(metalHistory);
  const fairValue = metalUsd != null && usdInr != null ? metalUsd * PARITY_MULT * usdInr : null;

  // Future expiry/DTE — drives the futures contract + basis convergence.
  const expiryIso = ups?.expiry ?? prevReal?.mcx?.expiry ?? nextMonthlyExpiry().toISOString().slice(0, 10);
  const dte = Math.max(0, Math.ceil((new Date(expiryIso).getTime() - Date.now()) / 86400000));
  // Option expiry/DTE — the contract an OPTIONS SELLER actually trades (MCX
  // silver options expire before the future). Drives theta, expected move,
  // the premium-sell read and the regime decision horizon. Falls back to the
  // future's expiry when there's no live option contract (parity estimate).
  const optionExpiryIso = ups?.optionExpiry ?? prevReal?.mcx?.optionExpiry ?? expiryIso;
  const optionDte = Math.max(0, Math.ceil((new Date(optionExpiryIso).getTime() - Date.now()) / 86400000));
  const t = optionDte / 365; // expected move is over the OPTION tenor

  const metalCloses = metalHistory.map((p) => p.v);
  const xauCloses = xauHistory.map((p) => p.v);
  // Rough realized-vol beta to gold, used ONLY as a fallback when the metal's
  // own history is too short to compute RV. Silver runs ~1.6x gold, copper
  // ~1.3x; gold is itself, so 1.0. Hand-set and deliberately crude — it only
  // ever seeds an estimate that is flagged `ivEstimated`.
  const VOL_BETA_TO_GOLD = { silver: 1.6, gold: 1.0, copper: 1.3 }[metal.id] ?? 1.5;
  function volSeries(closes, scale = 1) {
    const out = [];
    for (let i = 21; i < closes.length; i++) {
      const r = realizedVol(closes.slice(i - 21, i + 1), 20);
      if (Number.isFinite(r)) out.push(r * scale);
    }
    return out;
  }
  // Prefer silver's own realized vol; fall back to a gold-derived proxy when
  // silver history is still too short.
  let rv20 = realizedVol(metalCloses, 20);
  let rvSeries = volSeries(metalCloses);
  if (rv20 == null || rvSeries.length < 5) {
    const g = realizedVol(xauCloses, 20);
    if (g != null) rv20 = g * VOL_BETA_TO_GOLD;
    rvSeries = volSeries(xauCloses, VOL_BETA_TO_GOLD);
  }
  const rvClean = rvSeries.filter((x) => Number.isFinite(x));

  const ivRankFrom = (v) => (v != null && rvClean.length ? round(rangeRank(v, rvClean.concat(v)), 1) : null);
  // True percentile (share of the sample at-or-below), distinct from the
  // min-max range rank above — the two answer different questions.
  const ivPctileFrom = (v) =>
    v != null && rvClean.length
      ? round((rvClean.concat(v).filter((x) => x <= v).length / (rvClean.length + 1)) * 100, 1)
      : null;
  let estimated = true;
  // `ivEstimated` is true whenever ATM IV is a realized-vol proxy rather than a
  // real traded option price, AND whenever IV rank/percentile are ranked against
  // realized-vol history (we don't yet accumulate a real ATM-IV history). The UI
  // must label these so a proxy never reads as live market implied vol.
  let ivEstimated = true;
  let fut, prevClose, oi, oiChg, atmIv, ivRank, chain;
  if (ups) {
    // Real exchange data from Upstox.
    estimated = false;
    fut = ups.fut;
    prevClose = ups.prevClose;
    oi = ups.oi;
    oiChg = ups.oiChg;
    chain = ups.chain ?? [];
    // atmIv is real only when it came from option prices (chain greeks or solved
    // from option LTPs); otherwise it falls back to a realized-vol proxy.
    if (ups.atmIv != null) {
      atmIv = round(ups.atmIv, 4);
      ivEstimated = false;
    } else {
      atmIv = rv20 != null ? round(rv20 * 1.05, 4) : null;
      ivEstimated = true;
    }
    ivRank = ivRankFrom(rv20);
  } else if (prevReal) {
    // Upstox hiccup: keep last-good real MCX rather than reverting to a worse
    // parity estimate. dte already recomputed from the persisted expiry.
    estimated = false;
    fut = prevReal.mcx.fut;
    prevClose = prevReal.mcx.prevClose;
    oi = prevReal.mcx.oi;
    oiChg = prevReal.mcx.oiChg;
    chain = prevReal.options?.chain ?? [];
    atmIv = prevReal.options?.atmIv ?? (rv20 != null ? round(rv20 * 1.05, 4) : null);
    // Carry the prior flag; default to "estimated" when the field predates this.
    ivEstimated = prevReal.options?.ivEstimated ?? true;
    ivRank = ivRankFrom(rv20);
  } else {
    // Import-parity estimate (no exchange feed available).
    fut = fairValue != null ? Math.round(fairValue) : null;
    prevClose = metalHistory.length > 1 ? Math.round(metalHistory[metalHistory.length - 2].v * PARITY_MULT * usdInr) : null;
    oi = null;
    oiChg = null;
    chain = [];
    atmIv = rv20 != null ? round(rv20 * 1.05, 4) : null;
    ivRank = ivRankFrom(rv20);
  }

  // Real IV history: accumulate daily real ATM IV so rank/percentile can be
  // computed against ACTUAL implied vol instead of the realized-vol proxy.
  // Once ~a month of real IV exists (≥20 points) the rank flips to genuine.
  let ivPercentile = ivPctileFrom(rv20);
  let ivRankEstimated = true;
  let ivHistory = prev?.options?.ivHistory ?? [];
  if (!ivEstimated && atmIv != null) {
    ivHistory = mergeByDate(ivHistory, [{ t: new Date().toISOString().slice(0, 10), v: atmIv }]).slice(-370);
  }
  if (atmIv != null && ivHistory.length >= 20) {
    const ivs = ivHistory.map((p) => p.v);
    ivRank = round(rangeRank(atmIv, ivs), 1);
    ivPercentile = round((ivs.filter((x) => x <= atmIv).length / ivs.length) * 100, 1);
    ivRankEstimated = false;
  }

  const expectedMove1sd = atmIv != null && fut != null ? Math.round(fut * atmIv * Math.sqrt(t)) : null;
  const basis = fut != null && fairValue != null ? Math.round(fut - fairValue) : null;
  const gex = computeGex(chain, fut, t);
  // COMEX silver term structure — carry last-good if the fetch comes back empty.
  const curve = (await fetchCurve(metal, metalUsd)) ?? prev?.curve ?? null;

  // Live-feed health — lets the UI say "token not working" instead of silently
  // showing stale last-good. A 401/403 on any authed Upstox call = bad token.
  const authFailed = upstox.upstoxFeed.authFailed;
  const noToken = !process.env.UPSTOX_ACCESS_TOKEN;
  const liveChainOk = (ups?.chain?.length ?? 0) > 0; // real option chain THIS run
  const feed = {
    upstox: authFailed ? "auth_failed" : noToken ? "no_token" : liveChainOk ? "ok" : "degraded",
    chainOk: liveChainOk,
    // Timestamp of the last run that had a real live option chain (persisted).
    lastLiveAt: liveChainOk ? new Date().toISOString() : prev?.feed?.lastLiveAt ?? null,
  };

  // Per-expiry bundles behind the expiry selector. The nearest mirrors the
  // top-level fields above (so the default view is identical); far months are
  // best-effort with realized-vol-based (estimated) IV rank.
  // Strike step is DERIVED from the listed strikes — MCX changes it (gold went
  // ₹100 → ₹500 in Jan 2026), so a hardcoded 1000 would put the ATM marker on
  // a strike that does not exist.
  const step = strikeStep(metal, chain);
  const atmStrikeNear = fut != null ? Math.round(fut / step) * step : null;
  const nearBundle = {
    expiry: expiryIso, optionExpiry: optionExpiryIso, dte, optionDte,
    fut, prevClose, oi, oiChg, atmStrike: atmStrikeNear,
    atmIv, ivEstimated, ivRank, ivPercentile, ivRankEstimated,
    expectedMove1sd, gex, basis: { fairValue: round(fairValue, 0), basis }, chain,
  };
  const farBundles = (ups?.expiries ?? []).slice(1).map((b) => {
    const tY = (b.optionDte ?? 0) / 365;
    const bIv = b.atmIv != null ? round(b.atmIv, 4) : rv20 != null ? round(rv20 * 1.05, 4) : null;
    return {
      expiry: b.expiry, optionExpiry: b.optionExpiry, dte: b.dte, optionDte: b.optionDte,
      fut: b.fut, prevClose: b.prevClose, oi: b.oi, oiChg: b.oiChg,
      atmStrike: b.fut != null ? (() => { const st = strikeStep(metal, b.chain); return Math.round(b.fut / st) * st; })() : null,
      atmIv: bIv, ivEstimated: b.atmIv == null,
      ivRank: ivRankFrom(b.atmIv ?? rv20), ivPercentile: ivPctileFrom(b.atmIv ?? rv20), ivRankEstimated: true,
      expectedMove1sd: bIv != null && b.fut != null ? Math.round(b.fut * bIv * Math.sqrt(tY)) : null,
      gex: computeGex(b.chain, b.fut, tY),
      basis: {
        fairValue: round(fairValue, 0),
        basis: b.fut != null && fairValue != null ? Math.round(b.fut - fairValue) : null,
      },
      chain: b.chain,
    };
  });
  // Drop far months with no option chain — nothing to show, and selecting them
  // would render empty cards. The nearest is always kept.
  const usableFar = farBundles.filter((b) => b.chain.length > 0);
  const expiries = fut != null ? (ups ? [nearBundle, ...usableFar] : [nearBundle]) : prev?.expiries ?? null;

  // Per-strike OI change vs YESTERDAY's close. The snapshot is our state store:
  // hold a per-expiry baseline (yesterday's closing OI) for the whole IST day and
  // diff live OI against it, so `oiChg` means "written/unwound today", not since
  // the last 10-min refresh. Seeds from the prior snapshot's chain on a new day.
  const today = istToday();
  const prevBaseline = prev?.oiBaseline ?? {};
  const oiBaseline = {};
  for (const b of expiries ?? []) {
    const key = b.optionExpiry;
    const prevBase = prevBaseline[key];
    const base =
      prevBase && prevBase.date === today
        ? prevBase // baseline = yesterday's close, held all day
        : { date: today, byStrike: chainOiMap(prev?.expiries?.find((e) => e.optionExpiry === key)?.chain) };
    oiBaseline[key] = base;
    for (const o of b.chain ?? []) {
      const prevOi = base.byStrike?.[o.strike]?.[o.type];
      o.oiChg = prevOi != null && o.oi != null ? o.oi - prevOi : null;
    }
  }

  // `partial` reflects only CORE data (silver/gold/INR). Missing optional
  // factors (DXY, real yields) don't mark the whole snapshot as degraded.
  const corePartial = !(xauHistory.length > 5 && usdInrHistory.length > 5);
  const snapshot = {
    asOf: new Date().toISOString(),
    stale: false,
    partial: corePartial,
    estimated,
    live: {
      metalUsd: round(metalUsd, 2),
      xauUsd: round(xauUsd, 2),
      usdInr: round(usdInr, 3),
      dxy: round(dxy, 2),
      usdBroad, // true when `dxy` is the Fed Broad USD Index, not ICE DXY
      real10y: round(real10y, 2),
      breakeven10y,
      metalHistory,
      xauHistory,
      dxyHistory,
      real10yHistory,
      usdInrHistory,
      asOf: new Date().toISOString(),
      partial: corePartial,
    },
    mcx: {
      symbol: MCX_SYMBOL,
      fut,
      prevClose,
      expiry: expiryIso, // future expiry (basis convergence)
      dte,
      optionExpiry: optionExpiryIso, // option expiry (what a seller trades)
      optionDte,
      optionExpiries: ups?.optionExpiries?.length ? ups.optionExpiries : [optionExpiryIso], // all upcoming option expiries
      oi,
      oiChg,
    },
    options: {
      atmStrike: atmStrikeNear,
      atmIv,
      ivEstimated,
      ivRank,
      ivPercentile,
      ivRankEstimated,
      ivHistory,
      rv20: round(rv20, 4),
      expectedMove1sd,
      chain,
    },
    basis: { fairValue: round(fairValue, 0), basis },
    gex,
    curve, // COMEX silver futures term structure (contango/backwardation)
    feed, // live-feed / token health (auth_failed → UI warns to refresh token)
    expiries, // per-monthly-expiry bundles behind the expiry selector
    oiBaseline, // per-expiry yesterday's-close OI baseline (drives per-strike oiChg)

    cot: cotNew ?? prev?.cot ?? null, // weekly + lagged; keep last-good
    news: news ?? prev?.news ?? [],
    prints: prints.length ? prints : prev?.prints ?? [],
    events: buildEvents(optionExpiryIso),
  };

  console.log(
    `${metal.id}: intl=${metalUsd} inr=${usdInr} mcx=${fut} (${estimated ? "parity-est" : "live"}) ` +
      `iv=${atmIv} ivRank=${ivRank} dte=${dte} step=${step} chain=${chain.length} histLen=${metalHistory.length} feed=${feed.upstox}`,
  );
  return snapshot;
}

/** Compact per-metal card for the picker screen (public/data/index.json). */
function summaryOf(metal, snap) {
  if (!snap) return { id: metal.id, label: metal.label, emoji: metal.emoji, ok: false };
  const fut = snap.mcx?.fut ?? null;
  const prev = snap.mcx?.prevClose ?? null;
  const iv = snap.options?.atmIv ?? null;
  const rv = snap.options?.rv20 ?? null;
  return {
    id: metal.id,
    label: metal.label,
    emoji: metal.emoji,
    ok: true,
    symbol: snap.mcx?.symbol ?? metal.feedSymbol,
    quoteUnit: metal.quoteUnit,
    fut,
    changePct: fut != null && prev ? round(((fut - prev) / prev) * 100, 2) : null,
    atmIv: iv,
    ivRank: snap.options?.ivRank ?? null,
    ivEstimated: snap.options?.ivEstimated ?? true,
    // VRP in vol points — the picker's "is there anything to sell here" read.
    vrp: iv != null && rv != null ? round((iv - rv) * 100, 2) : null,
    optionDte: snap.mcx?.optionDte ?? null,
    chainLegs: snap.options?.chain?.length ?? 0,
    stale: snap.stale === true,
    estimated: snap.estimated === true,
    feed: snap.feed?.upstox ?? null,
    asOf: snap.asOf,
  };
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  // Load every metal's previous snapshot first — each is its own state store
  // (accumulated price history, real ATM-IV series, OI baselines, last-good
  // news/COT), so they must not be crossed over.
  const prevs = {};
  for (const id of BUILD_METALS) prevs[id] = await loadSnapshot(id);

  // Shared macro, fetched ONCE. Seeded from whichever snapshot has it so the
  // accumulated gold/INR/dollar histories survive across runs.
  const seed = prevs[DEFAULT_METAL]?.live ?? Object.values(prevs).find((p) => p?.live)?.live ?? null;
  const shared = await fetchShared(seed);

  // The MCX instrument master is ~all of MCX and is the largest fetch in the
  // pipeline — pull it once and hand the same array to every metal.
  const instruments = process.env.UPSTOX_ACCESS_TOKEN ? await upstox.fetchInstruments() : [];

  const summaries = [];
  let silverSnap = null;

  // Sequential, not parallel: three metals x up to four expiries x ~50 option
  // quotes each would burst Upstox's rate limit, and the cron has ten minutes.
  for (const id of BUILD_METALS) {
    const metal = METALS[id];
    let snap = null;
    try {
      snap = await buildMetal(metal, shared, prevs[id], instruments);
    } catch (e) {
      console.error(`${id}: build failed — ${e.message}`);
    }
    // Fail soft PER METAL. A dead copper feed must never blank out silver.
    if (!snap) snap = prevs[id] ? { ...prevs[id], stale: true } : null;
    if (snap) {
      await writeFile(metalFile(id), JSON.stringify(snap, null, 2) + "\n");
      if (id === DEFAULT_METAL) silverSnap = snap;
    } else {
      console.warn(`${id}: nothing to write (no live data and no prior snapshot).`);
    }
    summaries.push(summaryOf(metal, snap));
  }

  // The picker's data. Small on purpose — it is fetched before the user has
  // chosen a metal, so it must not carry any chain or history.
  await writeFile(
    resolve(DATA_DIR, "index.json"),
    JSON.stringify({ asOf: new Date().toISOString(), metals: summaries }, null, 2) + "\n",
  );

  // Back-compat: any already-deployed client still reads latest.json and knows
  // only about silver. Keep it a byte-for-byte copy of the silver snapshot.
  if (silverSnap) {
    await writeFile(LATEST, JSON.stringify(silverSnap, null, 2) + "\n");
  }

  console.log(
    "wrote " +
      summaries.map((m) => `${m.id}${m.ok ? "" : "(none)"}${m.stale ? "*" : ""}`).join(", ") +
      " + index.json" +
      (silverSnap ? " + latest.json" : ""),
  );
}

main().catch((e) => {
  console.error("build-data failed:", e);
  process.exit(1);
});

// trigger: data refresh with TWELVEDATA_KEY

// trigger: upstox token added

// trigger: FRED_KEY added (real 10y yields)

// trigger: manual refresh (session start 2026-07-14T04:05Z)
