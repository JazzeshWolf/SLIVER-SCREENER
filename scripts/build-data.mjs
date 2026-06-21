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
import * as upstox from "./upstox.mjs";

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

// --- CFTC Commitments of Traders (silver positioning, weekly) --------------
// Free Socrata JSON API. Managed-money net (disaggregated) preferred; legacy
// non-commercial net as fallback. COMEX silver contract code = 084691.
async function fetchCot() {
  const SILVER = "084691";
  const sources = [
    { id: "72hh-3qpy", long: "m_money_positions_long_all", short: "m_money_positions_short_all", label: "managed money" },
    { id: "6dca-aqww", long: "noncomm_positions_long_all", short: "noncomm_positions_short_all", label: "non-commercial" },
  ];
  for (const s of sources) {
    try {
      const q = `cftc_contract_market_code=${SILVER}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=170`;
      const url = `https://publicreporting.cftc.gov/resource/${s.id}.json?${q}`;
      const j = await getJson(url, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } });
      if (!Array.isArray(j) || !j.length) {
        console.warn(`cot ${s.id}: empty`);
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
      console.log(`cot: ${s.label} net=${latest} pctile=${percentile} n=${rows.length} asOf=${rows[rows.length - 1].t}`);
      return {
        net: Math.round(latest),
        percentile,
        asOf: rows[rows.length - 1].t,
        source: s.label,
        history: rows.slice(-78).map((r) => ({ t: r.t, v: Math.round(r.net) })),
      };
    } catch (e) {
      console.warn(`cot ${s.id}: ${e.message}`);
    }
  }
  return null;
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
async function fetchNews(prevNews) {
  const queries = [
    `https://news.google.com/rss/search?q=${encodeURIComponent("silver price OR silver MCX OR silver demand OR silver squeeze")}&hl=en-IN&gl=IN&ceid=IN:en`,
    `https://news.google.com/rss/search?q=${encodeURIComponent("silver price forecast OR silver Fed OR silver dollar OR silver rally")}&hl=en-US&gl=US&ceid=US:en`,
  ];
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
        const text = `${title} ${desc}`;
        if (!/silver|bullion|precious metal|MCX/i.test(text)) continue;
        const key = title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          title,
          url: link,
          source: source || "News",
          publishedAt: pub ? new Date(pub).toISOString() : new Date().toISOString(),
          snippet: desc.slice(0, 200),
          impact: tagImpact(text),
        });
      }
    } catch (e) {
      console.warn(`news ${url.slice(0, 48)}: ${e.message}`);
    }
  }
  items.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  const out = items.slice(0, 15);
  console.log(`news: ${out.length} items`);
  // NOTE: hook point — if a NEWS_AI_KEY is configured, an LLM could rewrite
  // `snippet`/`impact` per item here (cache by url to stay cheap). Rule-based for now.
  return out.length ? out : prevNews ?? [];
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
      if (rows.length) return toRaw(rows, MCX_SYMBOL, today, null);
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
async function fetchUpstox(usdInr) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
    const instruments = await upstox.fetchInstruments();
    const c = upstox.pickContract(instruments, MCX_SYMBOL, today);
    if (!c) {
      const sample = instruments
        .filter((i) => JSON.stringify(i).toUpperCase().includes("SILVER"))
        .slice(0, 4)
        .map((i) => ({ name: i.name, ts: i.trading_symbol, it: i.instrument_type, us: i.underlying_symbol, ot: i.option_type }));
      console.warn(`upstox: no ${MCX_SYMBOL} future. silver samples: ${JSON.stringify(sample)}`);
      return null;
    }
    const [{ history: futHist, oiHistory }, q, chainRaw] = await Promise.all([
      upstox.dailyCandles(token, c.future.key, from, today),
      upstox.quote(token, c.future.key),
      upstox.optionChain(token, c.future.key, c.expiry),
    ]);
    if (futHist.length < 5) {
      console.warn("upstox: thin futures history");
      return null;
    }
    const qd = Object.values(q)[0] ?? {};
    const ltp = Number(qd.last_price) || futHist[futHist.length - 1].v;
    const oi = Number(qd.oi) || (oiHistory.length ? oiHistory[oiHistory.length - 1].v : null);
    const prevClose = futHist.length > 1 ? futHist[futHist.length - 2].v : null;
    const oiChg =
      oiHistory.length > 1 && oi != null ? oi - oiHistory[oiHistory.length - 2].v : null;

    // ATM IV from the chain greeks (average of nearest CE/PE that report IV).
    let chain = chainRaw;
    let atmIv = null;
    const atmIvFromChain = (rows) => {
      if (!rows.length) return null;
      const k = rows.reduce((b, o) => (Math.abs(o.strike - ltp) < Math.abs(b - ltp) ? o.strike : b), rows[0].strike);
      const ivs = rows.filter((o) => o.strike === k && o.iv != null).map((o) => o.iv);
      return ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
    };
    atmIv = atmIvFromChain(chain);

    // The /option/chain endpoint can return no greeks (off-hours, or when it
    // wants a different underlying key). Fall back to solving Black-76 IV from
    // real option LTPs so IV stays a TRADED number, not a realized-vol proxy.
    if (atmIv == null && c.options?.length) {
      const fb = await upstox.ivFromOptionQuotes(token, c.options, ltp, c.expiry);
      if (fb.atmIv != null) atmIv = fb.atmIv;
      if ((!chain || !chain.length) && fb.chain.length) chain = fb.chain;
    }

    const dte = Math.max(0, Math.ceil((new Date(c.expiry).getTime() - Date.now()) / 86400000));
    // MCX future (₹/kg) -> implied $/oz so the engine sees real silver momentum.
    const mult = PARITY_MULT * (usdInr || 1);
    const silverUsdHistory = mult > 0 ? futHist.map((p) => ({ t: p.t, v: p.v / mult })) : [];

    console.log(`upstox: ${MCX_SYMBOL} fut=${ltp} oi=${oi} dte=${dte} hist=${futHist.length} chain=${chain.length} atmIv=${atmIv}`);
    return { silverFut: Math.round(ltp), prevClose, oi, oiChg, expiry: c.expiry, dte, atmIv, chain, silverUsdHistory };
  } catch (e) {
    console.warn(`upstox failed: ${e.message}`);
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

function builtinEvents() {
  // Static calendar with silver-impact metadata (direction / weight / mechanism).
  return [
    {
      name: "US Jobs (NFP)", date: "2026-07-02", kind: "us_jobs", impact: "twoway", weight: 2,
      effect: "Hot payrolls → hawkish Fed, ↑ yields & USD → silver DOWN. Weak jobs → silver UP.",
    },
    {
      name: "US CPI", date: "2026-07-10", kind: "us_cpi", impact: "twoway", weight: 3,
      effect: "Hot CPI → rate-cut hopes fade, real yields up → silver DOWN (inflation-hedge bid partly offsets).",
    },
    {
      name: "Fed FOMC", date: "2026-07-29", kind: "fomc", impact: "twoway", weight: 3,
      effect: "Dovish / cut → silver UP. Hawkish hold or hike risk → silver DOWN. Biggest IV-crush event.",
    },
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
    fetchSeries("xag", { td: ["XAG/USD", "XAGUSD", "SILVER", "XAG"], yahoo: "SI=F", stooq: "xagusd" }),
    fetchSeries("xau", { td: ["XAU/USD"], yahoo: "GC=F", stooq: "xauusd" }),
    // Only the genuine dollar index — aliases like DX/USDX map to unrelated
    // tickers on Twelve Data, so we'd rather drop DXY than use bad data.
    fetchSeries("dxy", { td: ["DXY"], yahoo: "DX-Y.NYB", stooq: "^dxy" }),
    fetchSeries("usdinr", { td: ["USD/INR"], yahoo: "INR=X", stooq: "usdinr" }),
    fredSeries("DFII10"),
    fredSeries("DGS10"),
  ]);

  // 2) Latest spot/FX ticks + CFTC positioning + silver news.
  const [xagSpot, xauSpot, inrSpot, cotNew, news] = await Promise.all([
    goldApi("XAG"),
    goldApi("XAU"),
    frankfurterInr(),
    fetchCot(),
    fetchNews(prev?.news),
  ]);

  // Use the fetched history when a provider returned a real series; otherwise
  // accumulate day-by-day from the live spot (persisted across runs) so e.g.
  // silver builds a genuine history even though no free API serves it.
  const prevLive = prev?.live ?? {};
  function buildHistory(fetched, prevKey, spot) {
    const base = fetched.length > 5 ? fetched : prevLive[prevKey] ?? [];
    return withLatest(base, spot);
  }
  let xagHistory = buildHistory(xagH, "xagHistory", xagSpot);
  const xauHistory = buildHistory(xauH, "xauHistory", xauSpot);
  const usdInrHistory = buildHistory(inrH, "usdInrHistory", inrSpot);
  // DXY has no spot fallback; if the real symbol is unavailable, drop it
  // entirely (don't carry a previously-stored bad series forward).
  const dxyHistory = dxyH.length > 5 ? dxyH : [];

  // Publish when we have enough to drive the engine. Silver history is ideal,
  // but gold + USD-INR alone still yield a meaningful (if weaker) bias.
  const haveCore = xagHistory.length > 5 || (xauHistory.length > 5 && usdInrHistory.length > 5);
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
  const xauUsd = last(xauHistory);
  const usdInr = last(usdInrHistory);
  const dxy = last(dxyHistory);
  const real10y = fredReal.length ? fredReal[fredReal.length - 1].v : null;
  const nominal10y = fredNom.length ? fredNom[fredNom.length - 1].v : null;
  const breakeven10y = nominal10y != null && real10y != null ? round(nominal10y - real10y, 2) : null;
  const real10yHistory = fredReal;

  // 3) MCX: real Upstox data (preferred) -> reuse last-good real -> parity.
  const ups = await fetchUpstox(usdInr);
  const prevReal = prev && prev.estimated === false ? prev : null;

  // Persist silver history: union of prior real silver + Upstox silver + today's
  // spot, so a transient Upstox hiccup never wipes the accumulated real history.
  const realSilver = ups?.silverUsdHistory?.length ? ups.silverUsdHistory : prevReal?.live?.xagHistory ?? [];
  xagHistory = mergeByDate(prevLive.xagHistory ?? [], realSilver, [
    { t: new Date().toISOString().slice(0, 10), v: xagSpot },
  ]);

  const xagUsd = last(xagHistory);
  const fairValue = xagUsd != null && usdInr != null ? xagUsd * PARITY_MULT * usdInr : null;

  const expiryIso = ups?.expiry ?? prevReal?.mcx?.expiry ?? nextMonthlyExpiry().toISOString().slice(0, 10);
  const dte = Math.max(0, Math.ceil((new Date(expiryIso).getTime() - Date.now()) / 86400000));
  const t = dte / 365;

  const xagCloses = xagHistory.map((p) => p.v);
  const xauCloses = xauHistory.map((p) => p.v);
  const SILVER_GOLD_VOL = 1.6; // silver realized vol ~1.6x gold's, historically
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
  let rv20 = realizedVol(xagCloses, 20);
  let rvSeries = volSeries(xagCloses);
  if (rv20 == null || rvSeries.length < 5) {
    const g = realizedVol(xauCloses, 20);
    if (g != null) rv20 = g * SILVER_GOLD_VOL;
    rvSeries = volSeries(xauCloses, SILVER_GOLD_VOL);
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
  let silverFut, prevClose, oi, oiChg, atmIv, ivRank, chain;
  if (ups) {
    // Real exchange data from Upstox.
    estimated = false;
    silverFut = ups.silverFut;
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
    silverFut = prevReal.mcx.silverFut;
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
    silverFut = fairValue != null ? Math.round(fairValue) : null;
    prevClose = xagHistory.length > 1 ? Math.round(xagHistory[xagHistory.length - 2].v * PARITY_MULT * usdInr) : null;
    oi = null;
    oiChg = null;
    chain = [];
    atmIv = rv20 != null ? round(rv20 * 1.05, 4) : null;
    ivRank = ivRankFrom(rv20);
  }

  const expectedMove1sd = atmIv != null && silverFut != null ? Math.round(silverFut * atmIv * Math.sqrt(t)) : null;
  const basis = silverFut != null && fairValue != null ? Math.round(silverFut - fairValue) : null;

  // `partial` reflects only CORE data (silver/gold/INR). Missing optional
  // factors (DXY, real yields) don't mark the whole snapshot as degraded.
  const corePartial = !(xauHistory.length > 5 && usdInrHistory.length > 5);
  const snapshot = {
    asOf: new Date().toISOString(),
    stale: false,
    partial: corePartial,
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
      partial: corePartial,
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
      ivEstimated,
      ivRank,
      ivPercentile: ivPctileFrom(rv20),
      rv20: round(rv20, 4),
      expectedMove1sd,
      chain,
    },
    basis: { fairValue: round(fairValue, 0), basis },
    cot: cotNew ?? prev?.cot ?? null, // weekly + lagged; keep last-good
    news: news ?? prev?.news ?? [],
    events: builtinEvents(),
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

// trigger: data refresh with TWELVEDATA_KEY

// trigger: upstox token added

// trigger: FRED_KEY added (real 10y yields)
