// ---------------------------------------------------------------------------
// Upstox market-data integration (read-only). Uses the 1-year "Analytics"
// access token (UPSTOX_ACCESS_TOKEN) — no daily re-auth, market data only.
//
// Pure-ish helpers + thin fetchers. All return null/[] on failure so the
// caller can fall back to parity/estimates. Endpoints per Upstox API v2.
// ---------------------------------------------------------------------------

import { gunzipSync } from "node:zlib";

const BASE = "https://api.upstox.com/v2";
const INSTRUMENTS_MCX = "https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz";
const INSTRUMENTS_ALL = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/** Fetch + gunzip the instrument master (MCX only, falling back to complete). */
export async function fetchInstruments() {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/gzip, application/octet-stream, application/json, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://upstox.com/",
  };
  for (const url of [INSTRUMENTS_MCX, INSTRUMENTS_ALL]) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const gz = buf[0] === 0x1f && buf[1] === 0x8b;
      if (!gz && (buf[0] === 0x3c /* '<' */ || buf.length < 100)) {
        throw new Error("blocked (HTML/empty response)");
      }
      const text = gz ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
      const arr = JSON.parse(text);
      if (Array.isArray(arr) && arr.length) {
        console.log(`upstox instruments: ${arr.length} from ${url}`);
        return arr;
      }
    } catch (e) {
      console.warn(`upstox instruments ${url}: ${e.message}`);
    }
  }
  return [];
}

function expiryToIso(e) {
  if (e == null) return null;
  if (typeof e === "number") return new Date(e).toISOString().slice(0, 10);
  const s = String(e);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(Number(s) || s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const norm = (r) => {
  const type = String(r.instrument_type ?? r.instrumentType ?? "").toUpperCase();
  const optType = String(r.option_type ?? r.optionType ?? "").toUpperCase();
  const names = [r.name, r.underlying_symbol, r.underlyingSymbol, r.asset_symbol, r.assetSymbol]
    .filter(Boolean)
    .map((x) => String(x).toUpperCase());
  return {
    key: r.instrument_key ?? r.instrumentKey,
    names,
    tradingSymbol: String(r.trading_symbol ?? r.tradingsymbol ?? "").toUpperCase(),
    type,
    optionType: optType === "CE" || optType === "PE" ? optType : type === "CE" || type === "PE" ? type : null,
    isFuture: type.includes("FUT"),
    isOption: type.includes("OPT") || optType === "CE" || optType === "PE" || type === "CE" || type === "PE",
    expiry: expiryToIso(r.expiry),
    strike: Number(r.strike_price ?? r.strikePrice ?? 0) || 0,
  };
};

function matchesSymbol(r, sym) {
  return r.names.includes(sym) || r.tradingSymbol.startsWith(sym);
}

/** Front-month future + option instrument keys for `symbol` (e.g. SILVERM). */
export function pickContract(instruments, symbol, todayIso) {
  const sym = symbol.toUpperCase();
  const rows = instruments.map(norm).filter((r) => r.key && matchesSymbol(r, sym));
  const futs = rows.filter((r) => r.isFuture && r.expiry);
  if (!futs.length) return null;
  const expiries = [...new Set(futs.map((f) => f.expiry))].sort();
  const expiry = expiries.find((e) => e >= todayIso) ?? expiries[0];
  const future = futs.find((f) => f.expiry === expiry);
  if (!future) return null;
  // MCX silver OPTIONS expire a few days BEFORE the future, so they do NOT share
  // the future's expiry — pick the options' own nearest expiry independently.
  const optRows = rows.filter((r) => r.isOption && r.expiry && r.optionType && r.strike > 0);
  const optExpiries = [...new Set(optRows.map((r) => r.expiry))].sort();
  const optionExpiry =
    optExpiries.find((e) => e >= todayIso) ?? optExpiries[optExpiries.length - 1] ?? expiry;
  const options = optRows.filter((r) => r.expiry === optionExpiry);
  return { future, options, expiry, optionExpiry };
}

/** Daily candles for an instrument: returns { history:[{t,v}], oiHistory:[{t,v}] }. */
export async function dailyCandles(token, instrumentKey, fromIso, toIso) {
  const url = `${BASE}/historical-candle/${encodeURIComponent(instrumentKey)}/day/${toIso}/${fromIso}`;
  try {
    const j = await getJson(url, { headers: authHeaders(token) });
    const candles = j?.data?.candles ?? [];
    // Each candle: [timestamp, open, high, low, close, volume, oi] (newest first).
    const history = [];
    const oiHistory = [];
    for (const c of candles) {
      const t = String(c[0]).slice(0, 10);
      const close = Number(c[4]);
      if (Number.isFinite(close) && close > 0) history.push({ t, v: close });
      if (c[6] != null && Number.isFinite(Number(c[6]))) oiHistory.push({ t, v: Number(c[6]) });
    }
    history.reverse();
    oiHistory.reverse();
    return { history, oiHistory };
  } catch (e) {
    console.warn(`upstox candles ${instrumentKey}: ${e.message}`);
    return { history: [], oiHistory: [] };
  }
}

/** Live quote: last price + OI for one or more instrument keys. */
export async function quote(token, instrumentKeys) {
  const keys = Array.isArray(instrumentKeys) ? instrumentKeys : [instrumentKeys];
  const url = `${BASE}/market-quote/quotes?instrument_key=${encodeURIComponent(keys.join(","))}`;
  try {
    const j = await getJson(url, { headers: authHeaders(token) });
    return j?.data ?? {};
  } catch (e) {
    console.warn(`upstox quote: ${e.message}`);
    return {};
  }
}

// --- Black-76 implied-vol solver (for when the option-chain endpoint returns
// no greeks — e.g. off-hours or wrong-underlying). Solves IV from option LTPs.
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
function b76(F, K, t, vol, type) {
  if (t <= 0 || vol <= 0 || F <= 0 || K <= 0) return type === "CE" ? Math.max(F - K, 0) : Math.max(K - F, 0);
  const sT = Math.sqrt(t);
  const d1 = (Math.log(F / K) + ((vol * vol) / 2) * t) / (vol * sT);
  const d2 = d1 - vol * sT;
  return type === "CE" ? F * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - F * normCdf(-d1);
}
function impliedVolB76(price, F, K, t, type) {
  if (!(price > 0) || t <= 0 || F <= 0 || K <= 0) return null;
  const intrinsic = type === "CE" ? Math.max(F - K, 0) : Math.max(K - F, 0);
  if (price < intrinsic - 1e-6) return null;
  let lo = 0.001, hi = 5, flo = b76(F, K, t, lo, type) - price;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const fm = b76(F, K, t, mid, type) - price;
    if (Math.abs(fm) < 1e-4) return mid;
    if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else hi = mid;
  }
  return null;
}

/**
 * Fallback IV + chain built directly from option LTPs (real traded prices),
 * for when /option/chain returns no greeks. Quotes a window of strikes around
 * ATM, solves Black-76 IV per leg. Returns { atmIv, chain } — null/[] on failure
 * so the caller is never worse off than the empty-chain case.
 */
export async function ivFromOptionQuotes(token, options, F, expiryIso) {
  try {
    if (!Array.isArray(options) || !options.length || !(F > 0)) return { atmIv: null, chain: [] };
    const t = Math.max((new Date(expiryIso).getTime() - Date.now()) / (365 * 86400000), 0.5 / 365);
    const strikes = [...new Set(options.map((o) => o.strike).filter((s) => s > 0))].sort((a, b) => a - b);
    if (!strikes.length) return { atmIv: null, chain: [] };
    const atm = strikes.reduce((b, s) => (Math.abs(s - F) < Math.abs(b - F) ? s : b), strikes[0]);
    const idx = strikes.indexOf(atm);
    const wanted = new Set(strikes.slice(Math.max(0, idx - 6), idx + 7));
    const sel = options.filter((o) => wanted.has(o.strike) && (o.optionType === "CE" || o.optionType === "PE"));
    if (!sel.length) return { atmIv: null, chain: [] };
    const q = await quote(token, sel.map((o) => o.key));
    const byKey = new Map();
    for (const v of Object.values(q)) {
      const k = v?.instrument_token ?? v?.instrument_key;
      if (k) byKey.set(k, v);
    }
    const chain = [];
    const atmIvs = [];
    for (const o of sel) {
      const v = byKey.get(o.key);
      const ltp = Number(v?.last_price ?? v?.ltp);
      if (!Number.isFinite(ltp) || ltp <= 0) continue;
      const iv = impliedVolB76(ltp, F, o.strike, t, o.optionType);
      chain.push({ strike: o.strike, type: o.optionType, ltp, iv, oi: Number(v?.oi ?? 0) || 0 });
      if (o.strike === atm && iv != null) atmIvs.push(iv);
    }
    const atmIv = atmIvs.length ? atmIvs.reduce((a, b) => a + b, 0) / atmIvs.length : null;
    if (chain.length) console.log(`upstox: solved IV from ${chain.length} option LTPs, atmIv=${atmIv}`);
    return { atmIv, chain };
  } catch (e) {
    console.warn(`upstox ivFromOptionQuotes: ${e.message}`);
    return { atmIv: null, chain: [] };
  }
}

/** Option chain with IV for the underlying future at a given expiry. */
export async function optionChain(token, underlyingKey, expiryIso) {
  const url = `${BASE}/option/chain?instrument_key=${encodeURIComponent(underlyingKey)}&expiry_date=${expiryIso}`;
  try {
    const j = await getJson(url, { headers: authHeaders(token) });
    const rows = j?.data ?? [];
    const chain = [];
    for (const r of rows) {
      const strike = Number(r.strike_price ?? r.strikePrice);
      for (const side of ["call_options", "put_options"]) {
        const o = r[side];
        if (!o) continue;
        const md = o.market_data ?? {};
        const gk = o.option_greeks ?? {};
        const ltp = Number(md.ltp ?? md.last_price);
        if (Number.isFinite(strike) && Number.isFinite(ltp) && ltp > 0) {
          chain.push({
            strike,
            type: side === "call_options" ? "CE" : "PE",
            ltp,
            iv: Number.isFinite(Number(gk.iv)) ? Number(gk.iv) / 100 : null, // Upstox IV is in %
            oi: Number(md.oi ?? 0) || 0,
          });
        }
      }
    }
    return chain;
  } catch (e) {
    console.warn(`upstox option chain: ${e.message}`);
    return [];
  }
}
