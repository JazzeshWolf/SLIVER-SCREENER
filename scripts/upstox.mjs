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
  for (const url of [INSTRUMENTS_MCX, INSTRUMENTS_ALL]) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const text = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
      const arr = JSON.parse(text);
      if (Array.isArray(arr) && arr.length) return arr;
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

const norm = (r) => ({
  key: r.instrument_key ?? r.instrumentKey,
  name: String(r.name ?? r.asset_symbol ?? "").toUpperCase(),
  type: String(r.instrument_type ?? r.instrumentType ?? "").toUpperCase(),
  expiry: expiryToIso(r.expiry),
  strike: Number(r.strike_price ?? r.strikePrice ?? 0) || 0,
  segment: String(r.segment ?? "").toUpperCase(),
  tradingSymbol: r.trading_symbol ?? r.tradingsymbol ?? "",
});

/** Front-month future + option instrument keys for `symbol` (e.g. SILVERM). */
export function pickContract(instruments, symbol, todayIso) {
  const sym = symbol.toUpperCase();
  const rows = instruments.map(norm).filter((r) => r.name === sym && r.key);
  const futs = rows.filter((r) => r.type === "FUT" && r.expiry);
  if (!futs.length) return null;
  const expiries = [...new Set(futs.map((f) => f.expiry))].sort();
  const expiry = expiries.find((e) => e >= todayIso) ?? expiries[0];
  const future = futs.find((f) => f.expiry === expiry);
  if (!future) return null;
  const options = rows.filter(
    (r) => (r.type === "CE" || r.type === "PE") && r.expiry === expiry && r.strike > 0,
  );
  return { future, options, expiry };
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
