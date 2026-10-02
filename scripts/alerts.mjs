// ---------------------------------------------------------------------------
// Telegram conviction alerts for the MCX metals screener (and crude oil).
//
// Ported from the NSE screener's engine (JazzeshWolf/xerxes scripts/alerts.mjs)
// and sending to the SAME bot and chat, so every message is headed "⚖️ MCX" to
// tell it apart from the NSE ones at a glance.
//
// Runs at the end of data.yml. Each run compares the fresh snapshots against
// the tracked set on the `alerts-state` branch and sends ONE Telegram message
// with everything that changed:
//
//   NEW      a strike on the Sell tab's DISPLAYED list reached the threshold
//   MOVED    tracked, still above, CONV changed by any amount
//   DROPPED  tracked, fell below the threshold → untracked
//   LEFT     tracked, no longer scored (filtered out, in the money, expiry
//            day, gone from the chain) → untracked
//
// Every message notifies with sound — the owner asked for no silent messages,
// moves included. Never set disable_notification.
//
// Where CONV comes from: unlike the NSE builder, this repo's builder does NOT
// store a conviction score — the Sell tab computes it in the browser. So the
// alerts recompute it from the snapshot through src/lib/sellView.ts, the same
// module the Sell tab renders from (entry = its top SELL_TOP_N per side per
// expiry). Two inputs cannot be reproduced server-side, so a CONV here can sit
// a point or two off the phone's: the browser overlays live spot on the
// direction score, and it keeps its own regime-hysteresis memory (here the
// memory lives in the state file).
//
// Freshness is judged from the data, never the clock alone. A metal counts only
// when its snapshot is not stale, carries a live option chain from THIS build
// (`feed.chainOk`), `feed.lastLiveAt` moved past the last one processed, that
// timestamp falls inside MCX trading hours, and the chain itself changed. The
// snapshot's top-level `asOf` is useless for this: the builder bumps it even
// when Upstox failed and it re-served yesterday's chain.
//
// Delivery is at-least-once: state is written only after Telegram accepts the
// message, so a failed send is retried by the next run instead of vanishing.
// A missing state file "arms" instead: one message listing what is already
// above the bar, so switching alerts on neither floods nor hides it.
//
// The pure pieces are unit-tested in alerts.test.mjs; main() is the thin I/O
// shell around them. This module must stay importable by plain `node` (the
// test-alert workflow runs --test/--mock without installing anything), so the
// TypeScript engine is only imported, dynamically, inside run().
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { METALS, METAL_IDS } from "../src/lib/metals.mjs";

export const DEFAULT_THRESHOLD = 70;
export const TIERS = { star: 75, fire: 80 };
/** Expiries watched per metal: the current one and the next (owner's choice,
 *  2026-09-25). Far months stay on the screen but never alert. */
export const ALERT_EXPIRIES = 2;
/** A strike needs this many days to expiry to START tracking (owner's choice,
 *  2026-09-25: every losing alert in the replay was presented with 5 days or
 *  fewer left). Once tracked it is followed to its exit regardless. Override
 *  with the repo variable ALERT_MIN_DTE_METALS. */
export const DEFAULT_MIN_DTE = 10;
const BRAND = "⚖️ MCX";
const SCREENER_URL = "https://jazzeshwolf.github.io/SLIVER-SCREENER/";
const TG_LIMIT = 3900; // Telegram caps a message at 4096 chars; leave headroom.

// --- time helpers (IST, and MCX's session) --------------------------------

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const ist = (d) => new Date(d.getTime() + IST_OFFSET_MS);
export const istDate = (d = new Date()) => ist(d).toISOString().slice(0, 10);
export const istTime = (d = new Date()) => ist(d).toISOString().slice(11, 16);
const istMinutes = (d) => ist(d).getUTCHours() * 60 + ist(d).getUTCMinutes();
const OPEN_MIN = 9 * 60;

const dayOfWeek = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = Sun
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** The n-th Sunday of a month (1-based), as an ISO date. */
function nthSunday(y, month, n) {
  const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay();
  return new Date(Date.UTC(y, month - 1, 1 + ((7 - first) % 7) + 7 * (n - 1))).toISOString().slice(0, 10);
}

/** US daylight saving on that date: 2nd Sunday of March → 1st Sunday of November. */
export function usDst(iso) {
  const y = Number(iso.slice(0, 4));
  return iso >= nthSunday(y, 3, 2) && iso < nthSunday(y, 11, 1);
}

/** MCX's close for bullion, base metals and energy, IST minutes: 23:30 while
 *  the US is on daylight time, 23:55 while it is not (the session tracks the
 *  US exchanges — COMEX for the metals, NYMEX for crude). */
export const closeMinutes = (iso) => (usDst(iso) ? 23 * 60 + 30 : 23 * 60 + 55);

/** Was this instant inside an MCX session (Mon–Fri, 09:00 → close IST)? */
export function inSession(d) {
  const date = istDate(d);
  const dow = dayOfWeek(date);
  const m = istMinutes(d);
  return dow >= 1 && dow <= 5 && m >= OPEN_MIN && m < closeMinutes(date);
}

/** The trading day an instant belongs to: before 09:00 IST it is still the
 *  previous session (a 02:00 run reports on last night's close), and a weekend
 *  belongs to Friday. */
export function sessionDate(d) {
  let date = istDate(d);
  if (istMinutes(d) < OPEN_MIN) date = addDays(date, -1);
  while (dayOfWeek(date) === 0 || dayOfWeek(date) === 6) date = addDays(date, -1);
  return date;
}

/** Has that session closed by this instant? */
export function afterClose(d, session) {
  const date = istDate(d);
  return date > session || (date === session && istMinutes(d) >= closeMinutes(session));
}

// --- freshness --------------------------------------------------------------

/** Everything the screen could rank on: every expiry's chain plus its future. */
export function chainFingerprint(snap) {
  const bundles = snap?.expiries?.length ? snap.expiries : [{ fut: snap?.mcx?.fut, chain: snap?.options?.chain }];
  const parts = bundles.map((b) =>
    [b.optionExpiry, b.fut, ...(b.chain ?? []).map((o) => `${o.strike}${o.type}${o.ltp}/${o.oi}`)].join(","),
  );
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** Is this metal's snapshot new market data since `prev` (its state entry)? */
export function freshness(snap, prev = {}) {
  if (!snap) return { fresh: false, why: "no snapshot" };
  if (snap.stale) return { fresh: false, why: "builder re-served last-good (stale)" };
  if (!snap.live) return { fresh: false, why: "no macro block to score direction" };
  const at = snap.feed?.lastLiveAt;
  if (!snap.feed?.chainOk || !at) return { fresh: false, why: "no live option chain this build" };
  if (prev.lastLiveAt && at <= prev.lastLiveAt) return { fresh: false, why: "not newer than the last run" };
  if (!inSession(new Date(at))) return { fresh: false, why: "captured outside MCX hours" };
  const fingerprint = chainFingerprint(snap);
  if (prev.fingerprint && fingerprint === prev.fingerprint) return { fresh: false, why: "chain unchanged (holiday?)" };
  return { fresh: true, lastLiveAt: at, fingerprint };
}

// --- collecting the current snapshot --------------------------------------

export const key = (metal, expiry, strike, type) => `${metal}|${expiry}|${strike}|${type}`;

const REASONS = {
  noIV: "no solvable IV",
  offSmile: "price off the smile",
  thinOI: "open interest too thin",
  tinyPrem: "premium decayed below the screen's floor",
  tooClose: "inside the gamma zone (< 0.6σ)",
};

const lotLabel = (metal, symbol) =>
  /\(([^)]+)\)/.exec(metal.contracts.find((c) => c.symbol === symbol)?.label ?? "")?.[1] ?? null;

/**
 * The expiries alerts watch: the ALERT_EXPIRIES nearest that can still be sold.
 * An expiry on its last day (DTE 0) has no ranked strikes and doesn't take a
 * slot — its tracked strikes leave as "expires today" and the watch moves on
 * to the next two months.
 */
export function watchedExpiries(view) {
  return view.expiries
    .filter((e) => e.optionExpiry && (e.optionDte ?? 0) > 0)
    .sort((a, b) => a.optionExpiry.localeCompare(b.optionExpiry))
    .slice(0, ALERT_EXPIRIES);
}

/**
 * Rows for every strike the screener scored on the watched expiries, from one
 * metal's sell view (see src/lib/sellView.ts). `displayed` marks the Sell
 * tab's list — the only rows allowed to START tracking. Rejected legs are kept
 * (ok: false) so a tracked strike that gets filtered out can say why it left.
 */
export function collectMetal(id, snap, view) {
  const metal = METALS[id];
  const symbol = snap.mcx?.symbol ?? metal.feedSymbol;
  const rows = new Map();
  const context = new Map(); // optionExpiry → { fut, tooThin }
  for (const e of watchedExpiries(view)) {
    context.set(e.optionExpiry, { fut: e.fut, tooThin: !!e.screen.tooThin });
    const shown = new Set([...e.shown.PE, ...e.shown.CE].map((c) => `${c.strike}${c.type}`));
    const block = e.gates.blocked
      ? e.gates.vrp.blocked ? "VRP negative — selling blocked" : "event veto — don't open new premium"
      : null;
    for (const c of e.screen.candidates) {
      rows.set(key(id, e.optionExpiry, c.strike, c.type), {
        metal: id, emoji: metal.emoji, symbol, expiry: e.optionExpiry, dte: e.optionDte,
        strike: c.strike, type: c.type, conviction: c.conv, ltp: c.premium,
        unit: metal.quoteUnit, lot: lotLabel(metal, symbol), credit: Math.round(c.credit),
        // The screen's estimated margin per lot and its chance the leg expires
        // worthless — the ROM and POP columns of the Telegram card.
        margin: Number.isFinite(c.marginPerLot) ? Math.round(c.marginPerLot) : null,
        pop: Number.isFinite(c.pOtm) ? c.pOtm : null,
        displayed: shown.has(`${c.strike}${c.type}`), ok: c.ok,
        why: c.ok ? null : `filtered out: ${c.reasons.map((r) => REASONS[r] ?? r).join(", ")}`,
        block,
      });
    }
  }
  return { rows, context };
}

/** Why a tracked strike has no row at all this run. */
export function explainMissing(t, context) {
  const ctx = context.get(t.expiry);
  if (!ctx) return "expiry no longer listed";
  if (ctx.tooThin) return "chain too thin to rank";
  if (ctx.fut != null && (t.type === "CE" ? ctx.fut >= t.strike : ctx.fut <= t.strike))
    return `now in the money (future ${Math.round(ctx.fut)})`;
  // Untraded (no LTP) or outside the builder's ±25-strike window.
  return "dropped off the fetched chain";
}

// --- the diff ---------------------------------------------------------------

const snapshotOf = (r) => ({
  metal: r.metal, emoji: r.emoji, symbol: r.symbol, expiry: r.expiry, strike: r.strike, type: r.type,
  conviction: r.conviction, ltp: r.ltp, unit: r.unit, lot: r.lot, credit: r.credit,
  margin: r.margin ?? null, pop: r.pop ?? null,
});
const keyOf = (r) => key(r.metal, r.expiry, r.strike, r.type);

/**
 * Compare tracked state with the current rows. Pure: returns the events and
 * the next tracked map, never mutates its inputs.
 */
export function diff(tracked, current, { threshold, today, isFresh, minDte = 0, explain = () => "no longer on the list" }) {
  const next = {};
  const events = [];
  for (const [k, t] of Object.entries(tracked)) {
    if (t.expiry < today) continue; // expired: drop quietly
    if (!isFresh(t)) {
      next[k] = t; // no fresh data for this metal this run — hold, say nothing
      continue;
    }
    const r = current.get(k);
    if (!r || !r.ok) {
      const expiring = t.expiry === today;
      const why = expiring ? "expires today" : r ? r.why : explain(t);
      events.push({ kind: "LEFT", from: t.conviction, row: t, expiring, why });
    } else if (r.conviction < threshold) {
      events.push({ kind: "DROPPED", from: t.conviction, row: r });
    } else {
      if (r.conviction !== t.conviction) events.push({ kind: "MOVED", from: t.conviction, row: r });
      next[k] = snapshotOf(r);
    }
  }
  const exited = new Set(events.map((e) => keyOf(e.row)));
  for (const [k, r] of current) {
    if (k in tracked || !r.displayed || !r.ok || r.conviction < threshold || r.expiry < today) continue;
    // Entry only: a tracked strike that runs under minDte keeps reporting.
    if ((r.dte ?? 0) < minDte) continue;
    if (!isFresh(r)) continue;
    // A contract that just dropped out this run is not re-entered in the same run.
    if (exited.has(k)) continue;
    events.push({ kind: "NEW", row: r });
    next[k] = snapshotOf(r);
  }
  const order = { NEW: 0, DROPPED: 1, LEFT: 2, MOVED: 3 };
  events.sort((a, b) => order[a.kind] - order[b.kind] || b.row.conviction - a.row.conviction);
  return { events, tracked: next };
}

// --- formatting -------------------------------------------------------------
//
// The Xerxes layout (owner's ask, 2026-10-01), so MCX and NSE alerts read the
// same way: one card per contract and expiry — a bold header carrying the
// metal's emoji and contract, then a <pre> table (monospace, with Telegram's
// copy button) holding NEW / MOVED / DROPPED / REMOVED / EXPIRED sections that
// share one set of columns. Rows stay ~34 characters so a phone held upright
// doesn't wrap them. Emoji go only at a row's END (the ⭐/🔥 tier), where their
// double width can't shift a later column.

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dm = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const ROWS_PER_BLOCK = 30;

export function tierMark(conv) {
  return conv >= TIERS.fire ? "🔥" : conv >= TIERS.star ? "⭐" : "";
}

/** Premium in at most ~5 characters: ₹1,486 · 79.4 · 2.32. */
const num = (n) => (n >= 1000 ? Math.round(n).toLocaleString("en-IN")
  : n >= 100 ? String(Number(Number(n).toFixed(1))) : String(Number(Number(n).toFixed(2))));
const daysLeft = (expiry, today) =>
  Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);

/** Credit ÷ the screen's estimated margin per lot, in %. Null without a margin. */
export function romPct(r) {
  return r?.credit != null && r?.margin > 0 ? (r.credit / r.margin) * 100 : null;
}

/**
 * One card: every event for one contract and expiry. MCX options are monthly
 * (the builder keeps monthlies only), so the line under the header always
 * says "Monthly"; a 🔴 line says when that expiry's VRP or event gate blocks
 * selling, and REMOVED rows get their reason under the table.
 */
function card(events, { today }) {
  const r0 = events[0].row;
  const dte = daysLeft(r0.expiry, today);
  const left = dte <= 0 ? "expires today" : dte === 1 ? "1 day left" : `${dte} days left`;
  const block = events.map((e) => e.row.block).find(Boolean);
  const head =
    `<b>${r0.emoji} ${esc(r0.symbol)} · ${dm(r0.expiry)}</b>\n` +
    `Monthly · ${left}${r0.lot ? ` · lot ${esc(r0.lot)}` : ""}` +
    (block ? `\n🔴 ${esc(block)}` : "");

  const sections = [
    ["ACTIVE", events.filter((e) => e.kind === "ACTIVE")],
    ["NEW", events.filter((e) => e.kind === "NEW")],
    ["MOVED", events.filter((e) => e.kind === "MOVED")],
    ["DROPPED", events.filter((e) => e.kind === "DROPPED")],
    ["REMOVED", events.filter((e) => e.kind === "LEFT" && !e.expiring)],
    ["EXPIRED", events.filter((e) => e.kind === "LEFT" && e.expiring)],
  ].filter(([, evs]) => evs.length);

  const conv = (e) =>
    e.kind === "NEW" || e.kind === "ACTIVE" ? String(e.row.conviction)
      : e.kind === "LEFT" ? `${e.from}→–` : `${e.from}→${e.row.conviction}`;
  const rom = (r) => { const v = romPct(r); return v == null ? "–" : v.toFixed(1); };
  const pop = (r) => (r.pop == null ? "–" : String(Math.round(r.pop * 100)));
  const cells = (e) => [`${e.row.strike}${e.row.type}`, conv(e), e.row.ltp == null ? "–" : num(e.row.ltp), rom(e.row), pop(e.row)];
  const all = events.map(cells);
  const w = [0, 1, 2, 3, 4].map((i) =>
    Math.max(i === 0 ? Math.max(...sections.map(([t]) => t.length)) : ["", "CONV", "PREM", "ROM", "POP"][i].length,
      ...all.map((c) => c[i].length)));
  const fmt = (c) => [c[0].padEnd(w[0]), ...c.slice(1).map((v, i) => v.padStart(w[i + 1]))].join(" ").trimEnd();
  const mark = (e) => (["NEW", "MOVED", "ACTIVE"].includes(e.kind) ? tierMark(e.row.conviction) : "");

  const body = sections.map(([title, evs]) =>
    [fmt([title, "CONV", "PREM", "ROM", "POP"]), ...evs.map((e) => fmt(cells(e)) + (mark(e) ? ` ${mark(e)}` : ""))].join("\n"));
  // Why a strike left: the one thing a table column can't carry on a phone.
  const why = events
    .filter((e) => e.kind === "LEFT" && !e.expiring)
    .map((e) => `<i>${e.row.strike}${e.row.type}: ${esc(e.why ?? "no longer on the list")}</i>`);
  return [`${head}\n<pre>${esc(body.join("\n\n"))}</pre>`, ...why].join("\n");
}

/** Cards ordered so fresh entries lead: groups holding a NEW first (highest
 *  conviction first), then the rest by expiry. */
function cards(events, opts) {
  const groups = new Map();
  for (const e of events) {
    const k = `${e.row.symbol}|${e.row.expiry}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const top = (evs) => Math.max(-1, ...evs.filter((e) => e.kind === "NEW").map((e) => e.row.conviction));
  return [...groups.values()]
    .sort((x, y) => top(y) - top(x) || x[0].row.expiry.localeCompare(y[0].row.expiry) || x[0].row.symbol.localeCompare(y[0].row.symbol))
    .flatMap((evs) => {
      // A very large group is split so no <pre> ever straddles two messages.
      const parts = [];
      for (let i = 0; i < evs.length; i += ROWS_PER_BLOCK) parts.push(card(evs.slice(i, i + ROWS_PER_BLOCK), opts));
      return parts;
    });
}

/** The alert rule in the heartbeat's words. */
const rule = (threshold, minDte) => `CONV ≥ ${threshold}${minDte > 0 ? `, entry ${minDte}+ days left` : ""}`;

/** One message per run (split only if Telegram's length cap forces it). */
export function formatMessages(events, { threshold, minDte = 0, when, today = istDate(), armed = false }) {
  if (!events.length && !armed) return [];
  const header = [`⚖️ <b>MCX · Commodities</b> · ${when} IST`];
  header.push(`<i>Alert level: conviction ${threshold}+${minDte > 0 ? ` · entry ${minDte}+ days left` : ""}</i>`);
  if (armed)
    header.push(events.length
      ? `✅ Alerts armed — already above the bar, now tracked (${events.length})`
      : "✅ Alerts armed — nothing above the bar right now");
  const footer = [
    "<i>PREM ₹ per kg / 10g / bbl · credit/lot = PREM × lot",
    "ROM % = credit ÷ margin per lot (broker-calibrated est.)",
    "POP % = model's chance it expires worthless",
    `DROPPED = fell below ${threshold} · REMOVED = off the list</i>`,
    `<a href="${SCREENER_URL}">Open screener</a>`,
  ].join("\n");
  const out = [];
  let cur = header.join("\n");
  for (const block of cards(events, { today })) {
    if (cur.length + block.length + footer.length + 4 > TG_LIMIT) {
      out.push(cur.trimEnd());
      cur = header[0] + " (cont.)";
    }
    cur += "\n\n" + block;
  }
  out.push(cur.trimEnd() + "\n\n" + footer);
  return out;
}

const emptyDay = (date) => ({ date, runs: Object.fromEntries(METAL_IDS.map((id) => [id, 0])), NEW: 0, MOVED: 0, DROPPED: 0, LEFT: 0 });

export function formatHeartbeat(state, session, threshold, minDte = 0) {
  const d = state?.day?.date === session ? state.day : emptyDay(session);
  const dead = METAL_IDS.filter((id) => !(d.runs?.[id] > 0));
  const last = state?.lastRunAt && d.date === session && !dead.length ? ` · last ${istTime(new Date(state.lastRunAt))}` : "";
  const runs = METAL_IDS.map((id) => `${METALS[id].emoji} ${d.runs?.[id] ?? 0}`).join("  ");
  const n = Object.keys(state?.tracked ?? {}).length;
  return [
    `${dead.length ? "⚠️" : "✓"} <b>${BRAND} alerts · end of day ${dm(session)}</b>`,
    `Runs checked: ${runs}${last}`,
    `${d.NEW} new, ${d.MOVED} moves, ${d.DROPPED + d.LEFT} exits · ${n} tracked now (${rule(threshold, minDte)})`,
    dead.length
      ? `\n${dead.map((id) => METALS[id].label).join(", ")} got no fresh data today — check the Actions tab (Refresh MCX data) and the Upstox token.`
      : "",
  ].join("\n").trimEnd();
}

// --- the "active contracts" test message -------------------------------------

/**
 * `--active` (Actions → Send test alert → "active"): a REAL test message, not
 * an invented one. It lists what the alerts are following right now: every
 * contract tracked in the state file, re-priced on the latest snapshot, plus
 * any strike on the watched expiries already above the bar that the next fresh
 * run would announce. Rendered by the real formatter under a TEST banner.
 * Sends only: it never writes the state, so it can't announce, drop or re-arm
 * anything, and it ignores freshness, so it works after hours and on weekends.
 */
export async function activeMessages({ dataDir, stateDir, now, threshold, minDte = 0 }) {
  const { sellView } = await import("../src/lib/sellView.ts");
  const state = readJson(resolve(stateDir, "metals.json"));
  const tracked = state?.tracked ?? {};
  const today = istDate(now);
  const rows = new Map();
  let asOf = null;
  for (const id of METAL_IDS) {
    const snap = readJson(resolve(dataDir, `${id}.json`));
    if (!snap?.live) continue;
    const { live, ...mcx } = snap;
    const view = sellView(live, mcx, state?.metals?.[id]?.regime, now);
    for (const [k, r] of collectMetal(id, snap, view).rows) rows.set(k, r);
    const at = snap.feed?.lastLiveAt;
    if (at && (!asOf || at > asOf)) asOf = at;
  }
  const events = [];
  for (const [k, t] of Object.entries(tracked)) {
    if (t.expiry < today) continue;
    events.push({ kind: "ACTIVE", row: rows.get(k) ?? t });
  }
  const tracking = events.length;
  for (const [k, r] of rows) {
    if (k in tracked || !r.displayed || !r.ok || r.conviction < threshold || r.expiry < today) continue;
    if ((r.dte ?? 0) < minDte) continue;
    events.push({ kind: "ACTIVE", row: r });
  }
  const priced = asOf ? `${dm(istDate(new Date(asOf)))} ${istTime(new Date(asOf))} IST` : "no live data";
  const banner = [
    `🧪 <b>TEST · active contracts</b> (real data, prices as of ${priced})`,
    `<i>Tracked by the alerts: ${tracking} · above the bar, not yet announced: ${events.length - tracking}</i>`,
  ].join("\n");
  if (!events.length)
    return [`${banner}\n\nNothing is tracked or above the bar right now (${rule(threshold, minDte)}).`];
  const msgs = formatMessages(events, { threshold, minDte, when: istTime(now), today });
  return [`${banner}\n\n${msgs[0]}`, ...msgs.slice(1)];
}

// --- state bookkeeping ------------------------------------------------------

export function bumpDay(state, freshIds, events, session, nowIso) {
  const day = state.day?.date === session ? { ...state.day, runs: { ...state.day.runs } } : emptyDay(session);
  for (const id of freshIds) day.runs[id] = (day.runs[id] ?? 0) + 1;
  for (const e of events) day[e.kind] += 1;
  return { ...state, day, lastRunAt: nowIso };
}

/** Invented sample for `--mock`: every line type, and a line for every commodity. */
export function mockEvents() {
  // Invented contracts at roughly current levels; margin is per lot, ROM and
  // POP come out of it the way they do for a real alert.
  const row = (id, expiry, strike, type, conviction, ltp, { block = null, margin = null, pop = 0.91 } = {}) => {
    const m = METALS[id];
    const symbol = m.feedSymbol;
    const lot = lotLabel(m, symbol);
    const units = m.contracts.find((c) => c.symbol === symbol).quoteUnitsPerLot;
    return { metal: id, emoji: m.emoji, symbol, expiry, strike, type, conviction, ltp, unit: m.quoteUnit, lot,
      credit: Math.round(ltp * units), margin, pop, block };
  };
  return [
    { kind: "NEW", row: row("silver", "2026-10-27", 262000, "CE", 81, 1485.5, { margin: 185000, pop: 0.93 }) },
    { kind: "NEW", row: row("gold", "2026-10-29", 144000, "PE", 76, 612, { block: "VRP negative — selling blocked", margin: 150000 }) },
    { kind: "NEW", row: row("copper", "2026-10-23", 1360, "PE", 71, 4.35, { margin: 250000, pop: 0.9 }) },
    { kind: "NEW", row: row("crude", "2026-10-15", 7500, "PE", 74, 55.25, { margin: 27400, pop: 0.92 }) },
    { kind: "DROPPED", from: 72, row: row("silver", "2026-10-27", 212000, "PE", 66, 1120, { margin: 180000, pop: 0.88 }) },
    { kind: "LEFT", from: 74, row: row("gold", "2026-10-29", 158000, "CE", 74, 410, { margin: 140000 }), why: "filtered out: inside the gamma zone (< 0.6σ)" },
    { kind: "MOVED", from: 73, row: row("silver", "2026-10-27", 216000, "PE", 75, 1310, { margin: 182000, pop: 0.9 }) },
    { kind: "MOVED", from: 78, row: row("copper", "2026-10-23", 1480, "CE", 77, 3.9, { margin: 240000, pop: 0.92 }) },
    { kind: "MOVED", from: 71, row: row("crude", "2026-10-15", 10200, "CE", 76, 60.5, { margin: 28100, pop: 0.9 }) },
  ];
}

// --- one run ------------------------------------------------------------------

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

/**
 * One alert run over the snapshot files in `dataDir`, against the state file
 * in `stateDir`. `send` must throw when a message is not accepted — the state
 * is written only after every send has returned.
 */
export async function run({ dataDir, stateDir, now, threshold, minDte = 0, send, log = console.log, onEvents = () => {} }) {
  const { sellView } = await import("../src/lib/sellView.ts");
  const statePath = resolve(stateDir, "metals.json");
  const prev = readJson(statePath);
  const today = istDate(now);
  const session = sessionDate(now);
  const when = istTime(now);

  const rows = new Map();
  const contexts = {};
  const fresh = new Set();
  const metals = { ...(prev?.metals ?? {}) };
  for (const id of METAL_IDS) {
    const snap = readJson(resolve(dataDir, `${id}.json`));
    const f = freshness(snap, prev?.metals?.[id]);
    if (!f.fresh) {
      log(`${id}: held — ${f.why}.`);
      continue;
    }
    const { live, ...mcx } = snap;
    const view = sellView(live, mcx, prev?.metals?.[id]?.regime, now);
    const c = collectMetal(id, snap, view);
    for (const [k, r] of c.rows) rows.set(k, r);
    contexts[id] = c.context;
    fresh.add(id);
    metals[id] = { lastLiveAt: f.lastLiveAt, fingerprint: f.fingerprint, regime: view.regime.regime };
    const shown = [...c.rows.values()].filter((r) => r.displayed);
    const best = shown.reduce((a, r) => Math.max(a, r.conviction), 0);
    log(`${id}: fresh (${f.lastLiveAt}) · ${view.regime.regime} · ${shown.length} shown, best CONV ${best}.`);
  }

  let state = prev ? { ...prev } : null;
  if (fresh.size) {
    const { events, tracked } = diff(prev?.tracked ?? {}, rows, {
      threshold, today, minDte,
      isFresh: (t) => fresh.has(t.metal),
      explain: (t) => explainMissing(t, contexts[t.metal]),
    });
    state = { version: 1, ...(prev ?? {}), tracked, metals };
    // First ever run: announce the starting set in ONE message rather than a
    // loud NEW per contract — switching alerts on never floods, and nothing
    // already above the bar is swallowed either.
    const armed = !prev;
    onEvents(events);
    const msgs = formatMessages(events, { threshold, minDte, when, today, armed });
    for (const m of msgs) await send(m);
    const tally = events.reduce((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {});
    log(armed
      ? `First run: armed, tracking ${Object.keys(tracked).length} contracts at ${rule(threshold, minDte)}.`
      : `${events.length} events ${JSON.stringify(tally)}, ${Object.keys(tracked).length} tracked, ${msgs.length} message(s) sent.`);
    state = bumpDay(state, fresh, armed ? [] : events, session, now.toISOString());
  } else if (!prev) {
    log("No fresh metal snapshot and no state yet — arming waits for the first fresh in-session run.");
    return;
  }

  // End-of-day heartbeat: the first run after MCX's close (23:30 / 23:55 IST).
  // Its absence the next morning is how the owner learns the pipeline stopped.
  if (afterClose(now, session) && state.heartbeatDate !== session) {
    await send(formatHeartbeat(state, session, threshold, minDte));
    state = { ...state, heartbeatDate: session };
    log("Heartbeat sent.");
  } else if (!fresh.size) {
    log("Nothing fresh — nothing to do.");
    return;
  }

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 1) + "\n");
}

// --- I/O --------------------------------------------------------------------

export async function sendTelegram(text) {
  if (process.env.ALERTS_DRY_RUN === "1") {
    console.log(`--- message ---\n${text}\n`);
    return;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  // No disable_notification, ever: every alert rings (owner's explicit ask).
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const body = await res.json().catch(() => ({}));
  // Never echo the URL: it carries the token, and Actions logs on a public
  // repo are public.
  if (!res.ok || !body.ok) throw new Error(`Telegram rejected the message: ${res.status} ${body.description ?? ""}`);
}

export async function main(argv = process.argv) {
  const dry = process.env.ALERTS_DRY_RUN === "1";
  if (!dry && (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID)) {
    console.log("::warning::TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — alerts skipped.");
    return;
  }
  if (argv.includes("--test")) {
    await sendTelegram(`✅ <b>${BRAND} metals alerts connected</b>\nThis chat will receive MCX metals conviction alerts (SLIVER-SCREENER).`);
    console.log("Test message sent.");
    return;
  }
  const envMin = Number(process.env.ALERT_MIN_CONV_METALS);
  // An unset repo variable arrives as "", which means "use the default"; 0 is
  // a real value (no minimum).
  const rawDte = process.env.ALERT_MIN_DTE_METALS ?? "";
  const envDte = rawDte.trim() === "" ? NaN : Number(rawDte);
  const threshold = Number.isFinite(envMin) && envMin > 0 ? envMin : DEFAULT_THRESHOLD;
  const minDte = Number.isFinite(envDte) && envDte >= 0 ? envDte : DEFAULT_MIN_DTE;
  if (argv.includes("--active")) {
    const msgs = await activeMessages({
      dataDir: process.env.ALERTS_DATA_DIR ?? "public/data",
      stateDir: process.env.ALERTS_STATE_DIR ?? "_alerts",
      now: new Date(),
      threshold,
      minDte,
    });
    for (const m of msgs) await sendTelegram(m);
    console.log(`Active-contracts test sent (${msgs.length} message${msgs.length === 1 ? "" : "s"}).`);
    return;
  }
  if (argv.includes("--mock")) {
    // Rendered by the real formatter so the owner sees exactly what a live
    // alert looks and sounds like. Contracts and prices are invented.
    const [m] = formatMessages(mockEvents(), { threshold: DEFAULT_THRESHOLD, minDte: DEFAULT_MIN_DTE, when: istTime(new Date()) });
    await sendTelegram("🧪 <b>MOCK ALERT (test only, not real)</b>\n\n" + m);
    console.log("Mock alert sent.");
    return;
  }
  await run({
    dataDir: process.env.ALERTS_DATA_DIR ?? "public/data",
    stateDir: process.env.ALERTS_STATE_DIR ?? "_alerts",
    now: process.env.ALERTS_NOW ? new Date(process.env.ALERTS_NOW) : new Date(),
    threshold,
    minDte,
    send: sendTelegram,
  });
}
