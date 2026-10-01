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
/** Expiries watched per metal: the current one and the next (owner's choice,
 *  2026-09-25). Far months stay on the screen but never alert. */
export const ALERT_EXPIRIES = 2;
/** A strike needs this many days to expiry to START tracking (owner's choice,
 *  2026-09-25: every losing alert in the replay was presented with 5 days or
 *  fewer left). Once tracked it is followed to its exit regardless. Override
 *  with the repo variable ALERT_MIN_DTE_METALS. */
export const DEFAULT_MIN_DTE = 10;
/**
 * The broker's margin for one short option, as a fraction of the contract's
 * value (future × units per lot). Used ONLY for the alerts' ROM column, which
 * the owner compares with their broker's "max profit %". Not the screener's
 * modelled SPAN margin (`marginPerLot`): that runs 4–5× under the broker's on
 * these contracts (COPPER Oct 1480 CE, 1 Oct 2026: ₹72,503 modelled vs ₹3.25L
 * at the broker), so ROM from it read 14% where the broker said 3.4%. It feeds
 * CONV and is frozen, so the alerts carry their own number instead, read off
 * the owner's broker. A commodity without one shows ROM as "–".
 */
export const MARGIN_PCT = {
  copper: 0.093, // ₹3.25L ÷ (1,398.45 × 2,500 kg), COPPER Oct 1480 CE, 2026-10-01
  silver: null,
  gold: null,
  crude: null,
};

/** Credit ÷ broker margin, in %: premium ÷ (margin rate × future). null without a rate or a future. */
export function romPct(id, premium, fut) {
  const pct = MARGIN_PCT[id];
  return pct && fut > 0 && premium != null ? Number(((premium / (pct * fut)) * 100).toFixed(2)) : null;
}

const BRAND_ICON = "⚖️";
const BRAND_NAME = "MCX";
const BRAND = `${BRAND_ICON} ${BRAND_NAME}`;
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

// Short on purpose: they print in the OUT table's REASON column, which has
// about 14 characters before a phone wraps the row.
const REASONS = {
  noIV: "no IV",
  offSmile: "off smile",
  thinOI: "thin OI",
  tinyPrem: "prem decayed",
  tooClose: "gamma zone",
};
const reasonOf = (codes) => {
  const [first, ...rest] = codes.map((r) => REASONS[r] ?? r);
  return rest.length ? `${first} +${rest.length}` : first;
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
        // Return on the broker's margin (not annualised; see MARGIN_PCT), and
        // the screen's forecast chance the strike expires worthless.
        rom: romPct(id, c.premium, e.fut),
        pop: Number.isFinite(c.pOtm) ? Number(c.pOtm.toFixed(4)) : null,
        displayed: shown.has(`${c.strike}${c.type}`), ok: c.ok,
        why: c.ok ? null : reasonOf(c.reasons),
        block,
      });
    }
  }
  return { rows, context };
}

/** Why a tracked strike has no row at all this run. */
export function explainMissing(t, context) {
  const ctx = context.get(t.expiry);
  if (!ctx) return "expiry gone";
  if (ctx.tooThin) return "chain too thin";
  if (ctx.fut != null && (t.type === "CE" ? ctx.fut >= t.strike : ctx.fut <= t.strike)) return "in the money";
  // Untraded (no LTP) or outside the builder's ±25-strike window.
  return "off the chain";
}

// --- the diff ---------------------------------------------------------------

const snapshotOf = (r) => ({
  metal: r.metal, emoji: r.emoji, symbol: r.symbol, expiry: r.expiry, strike: r.strike, type: r.type,
  conviction: r.conviction, ltp: r.ltp, unit: r.unit, lot: r.lot, credit: r.credit,
  // Kept so an exit and the end-of-day cards can still show ROM / POP and the gate.
  rom: r.rom ?? null, pop: r.pop ?? null, block: r.block ?? null,
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
// The same cards as the NSE screener's alerts (owner's ask, 2026-10-01: "look
// like the nifty alerts"). One card per commodity + expiry: a bold header
// outside the grid, then ONE <pre> holding NEW / ABOVE / MOVED / exit
// sections whose columns line up with each other. Telegram has no table
// markup; monospace is what keeps the columns aligned. Rows stay within ~34
// characters so a phone held upright doesn't wrap them, and nothing inside
// <pre> is an emoji (wider than a monospace cell, it would shift the columns).

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dm = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const ROWS_PER_BLOCK = 30;

/** Render rows as an aligned monospace table. `align` is "l"/"r" per column. */
export function table(head, rows, align) {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  const fmt = (cells) =>
    cells.map((c, i) => (align[i] === "r" ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join(" ").trimEnd();
  return all.map(fmt).join("\n");
}

// ≥ ₹1000 as a whole number, ≥ ₹100 to one decimal, so a premium never needs
// more than 6 characters.
const num = (n) => (n >= 1000 ? Math.round(n).toLocaleString("en-IN")
  : n >= 100 ? String(Number(Number(n).toFixed(1))) : String(Number(Number(n).toFixed(2))));
const daysLeft = (expiry, today) =>
  Math.round((Date.parse(expiry + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);

// Exits are split by reason so the reason is the section title rather than a
// column. The three that say something about the trade get their own title;
// the rest (thin chain, no IV, gone from the chain…) are REMOVED.
const EXIT_SECTIONS = [
  ["ITM", /^in the money/],
  ["GAMMA", /^gamma zone/],
  ["DECAYED", /^prem decayed/],
];
const exitTitle = (e) =>
  e.expiring ? "EXPIRED" : EXIT_SECTIONS.find(([, re]) => re.test(e.why ?? ""))?.[0] ?? "REMOVED";
const SECTION_ORDER = ["NEW", "ABOVE", "MOVED", "DROPPED", "ITM", "GAMMA", "DECAYED", "REMOVED", "EXPIRED"];
const titleOf = (e) =>
  e.kind === "NEW" ? "NEW" : e.kind === "HELD" ? "ABOVE" : e.kind === "MOVED" ? "MOVED" : e.kind === "DROPPED" ? "DROPPED" : exitTitle(e);

function card(events, { today }) {
  const r0 = events[0].row;
  const dte = daysLeft(r0.expiry, today);
  const left = dte <= 0 ? "expires today" : dte === 1 ? "1 day left" : `${dte} days left`;
  const head = [`${r0.emoji ?? ""} <b>${esc(r0.symbol)} · ${dm(r0.expiry)}</b>`.trim(),
    `${left}${r0.lot ? ` · lot ${esc(r0.lot)}` : ""}`];
  // A tracked row that has left carries the gate from when it was tracked;
  // only a current row speaks for the expiry now.
  const gate = events.find((e) => e.kind !== "LEFT" && e.row.block)?.row.block;
  if (gate) head.push(`🔴 ${esc(gate)}`);

  const romOf = (r) => (r.rom == null ? "–" : r.rom.toFixed(1));
  const popOf = (r) => (r.pop == null ? "–" : String(Math.round(r.pop * 100)));
  const convOf = (e) =>
    e.kind === "NEW" || e.kind === "HELD" ? String(e.row.conviction)
      : e.kind === "LEFT" ? `${e.from}→–` : `${e.from}→${e.row.conviction}`;
  const cells = (e) => [`${e.row.strike}${e.row.type}`, convOf(e), e.row.ltp == null ? "–" : num(e.row.ltp), romOf(e.row), popOf(e.row)];

  const bySection = new Map(SECTION_ORDER.map((t) => [t, []]));
  for (const e of events) bySection.get(titleOf(e)).push(e);
  bySection.get("ABOVE").sort((a, b) => b.row.conviction - a.row.conviction);
  const sections = [...bySection].filter(([, evs]) => evs.length);

  // Every row carries the same five columns, so they share one set of widths.
  const all = events.map(cells);
  const w = [0, 1, 2, 3, 4].map((i) =>
    Math.max(i === 0 ? Math.max(...sections.map(([t]) => t.length)) : ["", "CONV", "PREM", "ROM", "POP"][i].length,
      ...all.map((c) => c[i].length)));
  const fmt = (c) => [c[0].padEnd(w[0]), ...c.slice(1).map((v, i) => v.padStart(w[i + 1]))].join(" ").trimEnd();
  const body = sections.map(([title, evs]) =>
    [fmt([title, "CONV", "PREM", "ROM", "POP"]), ...evs.map((e) => fmt(cells(e)))].join("\n"));
  return `${head.join("\n")}\n<pre>${esc(body.join("\n\n"))}</pre>`;
}

/** Cards ordered so fresh entries lead: groups holding a NEW first (highest
 *  conviction first), then commodity order, then expiry. */
export function cards(events, opts) {
  const groups = new Map();
  for (const e of events) {
    const k = `${e.row.metal}|${e.row.expiry}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const top = (evs) => Math.max(-1, ...evs.filter((e) => e.kind === "NEW").map((e) => e.row.conviction));
  return [...groups.values()]
    .sort((x, y) => top(y) - top(x)
      || METAL_IDS.indexOf(x[0].row.metal) - METAL_IDS.indexOf(y[0].row.metal)
      || x[0].row.expiry.localeCompare(y[0].row.expiry))
    .flatMap((evs) => {
      // A very large group is split so no <pre> ever straddles two messages.
      const parts = [];
      for (let i = 0; i < evs.length; i += ROWS_PER_BLOCK) parts.push(card(evs.slice(i, i + ROWS_PER_BLOCK), opts));
      return parts;
    });
}

const UNIT_WORDS = { "₹/kg": "per kg", "₹/10g": "per 10 g", "₹/bbl": "per bbl" };

/** The legend under the cards. PREM's unit differs by contract, so the line
 *  names only the contracts in this message. */
function legend(rows, threshold, titles = new Set()) {
  const units = new Map();
  for (const r of rows) {
    const u = UNIT_WORDS[r.unit] ?? r.unit;
    if (!u) continue;
    if (!units.has(u)) units.set(u, new Set());
    units.get(u).add(r.symbol);
  }
  const lines = [];
  if (units.size) lines.push(`PREM ₹ ${[...units].map(([u, s]) => `${u} (${[...s].join(", ")})`).join(" · ")}`);
  const ids = [...new Set(rows.map((r) => r.metal))].filter((id) => METALS[id]);
  const rated = ids.filter((id) => MARGIN_PCT[id]);
  const unrated = ids.filter((id) => !MARGIN_PCT[id]);
  if (rated.length)
    lines.push(`ROM % = credit ÷ broker margin (${rated.map((id) => `${METALS[id].feedSymbol} ${(MARGIN_PCT[id] * 100).toFixed(1)}%`).join(", ")} of contract value)`);
  if (unrated.length) lines.push(`ROM – = no broker margin on file yet for ${unrated.map((id) => METALS[id].feedSymbol).join(", ")}`);
  lines.push("POP % = model's chance it expires worthless");
  if (threshold != null) lines.push(`DROPPED = fell below ${threshold} · REMOVED = off the list`);
  const extra = [
    ["ITM", "ITM = now in the money"],
    ["GAMMA", "GAMMA = too close to the price"],
    ["DECAYED", "DECAYED = premium too small to hold"],
  ].filter(([t]) => titles.has(t)).map(([, s]) => s);
  if (extra.length) lines.push(extra.join(" · "));
  return `<i>${esc(lines.join("\n"))}</i>`;
}

const alertLevel = (threshold, minDte) =>
  `Alert level: conviction ${threshold}+${minDte > 0 ? ` · ${minDte}+ days to expiry` : ""}`;

/** Fill messages with blocks, starting a new one only when Telegram's cap forces it. */
function pack(header, contHeader, blocks, footer) {
  const out = [];
  let cur = header;
  for (const block of blocks) {
    if (cur.length + block.length + footer.length + 4 > TG_LIMIT) {
      out.push(cur.trimEnd());
      cur = contHeader;
    }
    cur += "\n\n" + block;
  }
  out.push(cur.trimEnd() + "\n\n" + footer);
  return out;
}

/** One message per run (split only if Telegram's length cap forces it). */
export function formatMessages(events, { threshold, minDte = 0, when, today = istDate(), armed = false }) {
  if (!events.length && !armed) return [];
  const title = `${BRAND_ICON} <b>${BRAND_NAME}</b> · ${when} IST`;
  const header = [title, `<i>${esc(alertLevel(threshold, minDte))}</i>`];
  if (armed)
    header.push(events.length
      ? `✅ Alerts armed — already above the bar, now tracked (${events.length})`
      : "✅ Alerts armed — nothing above the bar right now");
  const titles = new Set(events.map(titleOf));
  const link = `<a href="${SCREENER_URL}">Open screener</a>`;
  const footer = events.length ? `${legend(events.map((e) => e.row), threshold, titles)}\n${link}` : link;
  return pack(header.join("\n"), `${title} (cont.)`, cards(events, { today }), footer);
}

const emptyCounts = () => ({ NEW: 0, MOVED: 0, DROPPED: 0, LEFT: 0 });
const emptyDay = (date) => ({
  date,
  runs: Object.fromEntries(METAL_IDS.map((id) => [id, 0])),
  events: Object.fromEntries(METAL_IDS.map((id) => [id, emptyCounts()])),
});

/**
 * End-of-day report, sent on the first run after MCX's close: the day's run
 * counts per commodity, then every contract still tracked at the close, as
 * the same cards the alerts use. Its absence the next morning is how the
 * owner learns the pipeline stopped.
 */
export function formatEod(state, session, threshold) {
  const d = state?.day?.date === session ? state.day : emptyDay(session);
  const dead = METAL_IDS.filter((id) => !(d.runs?.[id] > 0));
  const tracked = Object.values(state?.tracked ?? {});
  const t = table(["", "Runs", "New", "Moves", "Exits", "Now"], METAL_IDS.map((id) => {
    const c = d.events?.[id] ?? emptyCounts();
    return [METALS[id].label, d.runs?.[id] ?? 0, c.NEW, c.MOVED, c.DROPPED + c.LEFT, tracked.filter((x) => x.metal === id).length];
  }), ["l", "r", "r", "r", "r", "r"]);
  const title = `<b>${BRAND_NAME} · end of day ${dm(session)}</b>`;
  const last = d === state?.day && state?.lastRunAt ? istTime(new Date(state.lastRunAt)) : "—";
  const header = [
    `${dead.length ? "⚠️" : "📋"} ${title}`,
    `<pre>${esc(t)}</pre>`,
    `Last run: ${last} IST`,
  ];
  if (dead.length)
    header.push(`\n⚠️ ${dead.map((id) => METALS[id].label).join(", ")} got no fresh data today — check the Actions tab (Refresh MCX data) and the Upstox token.`);

  const held = tracked.filter((x) => x.expiry >= session && x.conviction >= threshold);
  const blocks = [`${BRAND_ICON} <b>At ${threshold}+ at the close (${held.length})</b>${held.length ? "" : "\nNone."}`];
  blocks.push(...cards(held.map((row) => ({ kind: "HELD", row })), { today: session }));
  const link = `<a href="${SCREENER_URL}">Open screener</a>`;
  const footer = held.length ? `${legend(held, null)}\n${link}` : link;
  return pack(header.join("\n"), `📋 ${title} (cont.)`, blocks, footer);
}

// --- state bookkeeping ------------------------------------------------------

export function bumpDay(state, freshIds, events, session, nowIso) {
  const prev = state.day?.date === session && state.day.events ? state.day : emptyDay(session);
  const day = {
    ...prev,
    runs: { ...prev.runs },
    events: Object.fromEntries(METAL_IDS.map((id) => [id, { ...(prev.events[id] ?? emptyCounts()) }])),
  };
  for (const id of freshIds) day.runs[id] = (day.runs[id] ?? 0) + 1;
  for (const e of events) day.events[e.row.metal][e.kind] += 1;
  return { ...state, day, lastRunAt: nowIso };
}

/** Invented sample for `--mock`: a card for every commodity and a row in
 *  every section, dated from `today` so the days-left line stays plausible. */
export function mockEvents(today = istDate()) {
  const FUT = { silver: 226760, gold: 148339, copper: 1398.45, crude: 8907 };
  const row = (id, days, strike, type, conviction, ltp, pop, block = null) => {
    const m = METALS[id];
    const symbol = m.feedSymbol;
    const units = m.contracts.find((c) => c.symbol === symbol).quoteUnitsPerLot;
    return {
      metal: id, emoji: m.emoji, symbol, expiry: addDays(today, days), dte: days, strike, type, conviction, ltp,
      unit: m.quoteUnit, lot: lotLabel(m, symbol), credit: Math.round(ltp * units), rom: romPct(id, ltp, FUT[id]), pop, block,
    };
  };
  return [
    { kind: "NEW", row: row("silver", 26, 262000, "CE", 81, 1485.5, 0.93) },
    { kind: "NEW", row: row("gold", 28, 144000, "PE", 76, 612, 0.91, "VRP negative — selling blocked") },
    { kind: "NEW", row: row("copper", 22, 1360, "PE", 71, 4.35, 0.9) },
    { kind: "NEW", row: row("crude", 14, 4900, "PE", 74, 21, 0.92) },
    { kind: "DROPPED", from: 72, row: row("silver", 26, 212000, "PE", 66, 1120, 0.88) },
    { kind: "LEFT", from: 71, row: row("silver", 26, 205000, "PE", 71, 640, 0.95), why: "prem decayed" },
    { kind: "LEFT", from: 74, row: row("gold", 28, 158000, "CE", 74, 410, 0.9), why: "gamma zone" },
    { kind: "MOVED", from: 73, row: row("silver", 26, 216000, "PE", 75, 1310, 0.9) },
    { kind: "MOVED", from: 78, row: row("copper", 22, 1480, "CE", 77, 3.9, 0.92) },
    { kind: "MOVED", from: 71, row: row("crude", 14, 6300, "CE", 76, 18, 0.94) },
  ];
}

/** State for a mock end-of-day report: the mock's surviving rows tracked, and a day's counts. */
export function mockState(session = sessionDate(new Date())) {
  const events = mockEvents(session);
  const tracked = Object.fromEntries(events.filter((e) => e.kind === "NEW" || e.kind === "MOVED")
    .map((e) => [keyOf(e.row), snapshotOf(e.row)]));
  return bumpDay({ tracked }, METAL_IDS, events, session, new Date().toISOString());
}

// --- one run ------------------------------------------------------------------

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

/**
 * One alert run over the snapshot files in `dataDir`, against the state file
 * in `stateDir`. `send` must throw when a message is not accepted — the state
 * is written only after every send has returned. `onEvents` sees each run's
 * events (the replay counts them).
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
    const msgs = formatMessages(events, { threshold, minDte, when, today, armed });
    for (const m of msgs) await send(m);
    onEvents(events, { armed });
    const tally = events.reduce((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {});
    log(armed
      ? `First run: armed, tracking ${Object.keys(tracked).length} contracts (${alertLevel(threshold, minDte)}).`
      : `${events.length} events ${JSON.stringify(tally)}, ${Object.keys(tracked).length} tracked, ${msgs.length} message(s) sent.`);
    state = bumpDay(state, fresh, armed ? [] : events, session, now.toISOString());
  } else if (!prev) {
    log("No fresh metal snapshot and no state yet — arming waits for the first fresh in-session run.");
    return;
  }

  // End-of-day report: the first run after MCX's close (23:30 / 23:55 IST).
  // Its absence the next morning is how the owner learns the pipeline stopped.
  if (afterClose(now, session) && state.heartbeatDate !== session) {
    for (const m of formatEod(state, session, threshold)) await send(m);
    state = { ...state, heartbeatDate: session };
    log("End-of-day report sent.");
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
  if (argv.includes("--mock")) {
    // Rendered by the real formatter so the owner sees exactly what a live
    // alert looks and sounds like. Contracts and prices are invented.
    const now = new Date();
    const mock = "🧪 <b>MOCK (test only, not real)</b>\n\n";
    for (const m of formatMessages(mockEvents(istDate(now)), {
      threshold: DEFAULT_THRESHOLD, minDte: DEFAULT_MIN_DTE, when: istTime(now), today: istDate(now),
    })) await sendTelegram(mock + m);
    const session = sessionDate(now);
    for (const m of formatEod(mockState(session), session, DEFAULT_THRESHOLD)) await sendTelegram(mock + m);
    console.log("Mock alert and mock end-of-day report sent.");
    return;
  }
  const envMin = Number(process.env.ALERT_MIN_CONV_METALS);
  // An unset repo variable arrives as "", which means "use the default"; 0 is
  // a real value (no minimum).
  const rawDte = process.env.ALERT_MIN_DTE_METALS ?? "";
  const envDte = rawDte.trim() === "" ? NaN : Number(rawDte);
  await run({
    dataDir: process.env.ALERTS_DATA_DIR ?? "public/data",
    stateDir: process.env.ALERTS_STATE_DIR ?? "_alerts",
    now: process.env.ALERTS_NOW ? new Date(process.env.ALERTS_NOW) : new Date(),
    threshold: Number.isFinite(envMin) && envMin > 0 ? envMin : DEFAULT_THRESHOLD,
    minDte: Number.isFinite(envDte) && envDte >= 0 ? envDte : DEFAULT_MIN_DTE,
    send: sendTelegram,
  });
}
