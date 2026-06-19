// ---------------------------------------------------------------------------
// Token-free MCX Bhavcopy parsing + contract selection (pure functions).
//
// The network fetch lives in build-data.mjs; everything here is pure so it can
// be unit-tested against a fixture (the MCX JSON schema is stable but its field
// casing varies, so access is deliberately case-insensitive + multi-alias).
// ---------------------------------------------------------------------------

const MONTHS = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/** Build a lowercased-key view of a row for case-insensitive access. */
function lcKeys(row) {
  const out = {};
  for (const k of Object.keys(row)) out[k.toLowerCase().replace(/[\s_]/g, "")] = row[k];
  return out;
}

/** First present value among alias keys (already lowercased/stripped). */
function field(lc, aliases) {
  for (const a of aliases) {
    const v = lc[a];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** Parse MCX expiry strings to ISO yyyy-mm-dd. Supports DDMMMYYYY, ISO, dd-mm-yyyy. */
export function parseExpiryToIso(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;

  // ISO already: 2026-07-04 / 2026/07/04
  let m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // DDMMMYYYY: 04JUL2026 or 04-JUL-2026
  m = s.match(/^(\d{1,2})[-]?([A-Z]{3})[-]?(\d{4})/);
  if (m && MONTHS[m[2]]) return `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, "0")}`;

  // dd-mm-yyyy / dd/mm/yyyy
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Normalize one bhavcopy row into a typed shape we care about. */
export function normalizeRow(row) {
  const lc = lcKeys(row);
  const instrument = String(field(lc, ["instrumentname", "instrument"]) ?? "").toUpperCase();
  const symbol = String(field(lc, ["symbol", "commodity"]) ?? "").toUpperCase();
  const optTypeRaw = String(field(lc, ["optiontype", "opttype"]) ?? "").toUpperCase();
  const optionType = optTypeRaw === "CE" || optTypeRaw === "PE" ? optTypeRaw : null;
  return {
    instrument,
    symbol,
    optionType,
    isOption: instrument.includes("OPT") || optionType !== null,
    isFuture: instrument.includes("FUT") && optionType === null,
    expiry: parseExpiryToIso(field(lc, ["expirydate", "expiry", "expirydt"])),
    strike: num(field(lc, ["strikeprice", "strike"])) ?? 0,
    close: num(field(lc, ["close", "closeprice", "settlementprice", "settle"])),
    prevClose: num(field(lc, ["previousclose", "prevclose", "prevcls"])),
    oi: num(field(lc, ["openinterest", "oi"])),
  };
}

/** Earliest expiry on/after `todayIso`, else the earliest available. */
function nearestExpiry(expiries, todayIso) {
  const valid = [...new Set(expiries.filter(Boolean))].sort();
  if (!valid.length) return null;
  const future = valid.filter((e) => e >= todayIso);
  return (future.length ? future : valid)[0];
}

/**
 * Select the front-month future + its option chain for `symbol` from raw rows.
 * Returns null when no matching future is found.
 *
 * @param maxStrikes cap the chain to the N strikes nearest the future price.
 */
export function pickContract(rows, symbol, todayIso, maxStrikes = 30) {
  const sym = symbol.toUpperCase();
  const norm = rows.map(normalizeRow).filter((r) => r.symbol === sym);
  const futures = norm.filter((r) => r.isFuture && r.expiry);
  if (!futures.length) return null;

  const expiry = nearestExpiry(futures.map((f) => f.expiry), todayIso);
  const future = futures.find((f) => f.expiry === expiry);
  if (!future || future.close == null) return null;

  let chain = norm
    .filter((r) => r.isOption && r.expiry === expiry && r.optionType && r.close && r.close > 0 && r.strike > 0)
    .map((o) => ({ strike: o.strike, type: o.optionType, ltp: o.close, oi: o.oi ?? 0 }));

  // Keep the strikes nearest the future to bound the committed file size.
  chain.sort((a, b) => Math.abs(a.strike - future.close) - Math.abs(b.strike - future.close));
  chain = chain.slice(0, maxStrikes).sort((a, b) => a.strike - b.strike);

  return { symbol: sym, expiry, future, chain };
}

/**
 * Map current (+ optional previous-day) bhavcopy rows to the raw shape the
 * pipeline expects. `prevRows` is only used to compute the OI change.
 */
export function toRaw(rows, symbol, todayIso, prevRows = null) {
  const cur = pickContract(rows, symbol, todayIso);
  if (!cur) return null;

  let oiChg = null;
  if (prevRows) {
    const prev = pickContract(prevRows, symbol, todayIso);
    // Same contract = same expiry; otherwise the diff is meaningless.
    if (prev && prev.expiry === cur.expiry && prev.future.oi != null && cur.future.oi != null) {
      oiChg = cur.future.oi - prev.future.oi;
    }
  }

  return {
    symbol: cur.symbol,
    silverFut: cur.future.close,
    prevClose: cur.future.prevClose ?? null,
    expiry: cur.expiry,
    oi: cur.future.oi ?? null,
    oiChg,
    chain: cur.chain,
  };
}
