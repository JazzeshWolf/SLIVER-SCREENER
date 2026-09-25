// ---------------------------------------------------------------------------
// Telegram conviction alerts for the MCX metals screener.
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

/** MCX's close for bullion and base metals, IST minutes: 23:30 while the US is
 *  on daylight time, 23:55 while it is not (the session tracks COMEX). */
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
 * Rows for every strike the screener scored, from one metal's sell view (see
 * src/lib/sellView.ts). `displayed` marks the Sell tab's list — the only rows
 * allowed to START tracking. Rejected legs are kept (ok: false) so a tracked
 * strike that gets filtered out can say why it left.
 */
export function collectMetal(id, snap, view) {
  const metal = METALS[id];
  const symbol = snap.mcx?.symbol ?? metal.feedSymbol;
  const rows = new Map();
  const context = new Map(); // optionExpiry → { fut, tooThin }
  for (const e of view.expiries) {
    if (!e.optionExpiry) continue;
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
});
const keyOf = (r) => key(r.metal, r.expiry, r.strike, r.type);

/**
 * Compare tracked state with the current rows. Pure: returns the events and
 * the next tracked map, never mutates its inputs.
 */
export function diff(tracked, current, { threshold, today, isFresh, explain = () => "no longer on the list" }) {
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

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rupee = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
const price = (n) => "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dm = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

export function tierMark(conv) {
  return conv >= TIERS.fire ? "🔥" : conv >= TIERS.star ? "⭐" : "";
}

// MCX metal options list one expiry per month (the builder keeps monthlies
// only), so there is no weekly/monthly label to carry here.
const contract = (r) => `${r.emoji} <b>${esc(r.symbol)} ${r.strike} ${r.type}</b> · ${dm(r.expiry)}`;
const prem = (r) => `${price(r.ltp)}${r.unit ? esc(r.unit.replace("₹", "")) : ""}`;

function line(e, threshold) {
  const r = e.row;
  const mark = tierMark(r.conviction);
  switch (e.kind) {
    case "NEW": {
      const lot = r.lot ? ` · lot ${esc(r.lot)}` : "";
      const block = r.block ? `\n      🔴 ${esc(r.block)}` : "";
      return `🔔 NEW ${mark}${r.conviction}  ${contract(r)}\n      prem ${prem(r)}${lot} · credit ${rupee(r.credit)}/lot${block}`;
    }
    case "MOVED":
      return `${r.conviction > e.from ? "⬆️" : "⬇️"} ${e.from} → ${mark}${r.conviction}  ${contract(r)} · ${prem(r)}${r.block ? " · 🔴 blocked" : ""}`;
    case "DROPPED":
      return `🔻 ${e.from} → ${r.conviction}  ${contract(r)} · ${prem(r)}\n      below ${threshold}, no longer tracked`;
    case "LEFT":
      return `🚪 ${contract(r)} · last CONV ${e.from}\n      ${esc(e.why ?? "no longer on the list")}, no longer tracked`;
  }
}

/** One message per run (split only if Telegram's length cap forces it). */
export function formatMessages(events, { threshold, when, armed = false }) {
  if (!events.length && !armed) return [];
  const header = [`<b>${BRAND} · Metals CONV ≥ ${threshold}</b> · ${when} IST`];
  if (armed)
    header.push(events.length
      ? `✅ Alerts armed. Already above the bar and now tracked (${events.length}):`
      : "✅ Alerts armed. Nothing above the bar right now.");
  const body = events.map((e) => line(e, threshold));
  const footer = `<a href="${SCREENER_URL}">Open screener</a>`;
  const out = [];
  let cur = header.join("\n") + "\n";
  for (const l of body) {
    if (cur.length + l.length + footer.length + 4 > TG_LIMIT) {
      out.push(cur.trimEnd());
      cur = header[0] + " (cont.)\n";
    }
    cur += "\n" + l;
  }
  out.push(cur.trimEnd() + "\n\n" + footer);
  return out;
}

const emptyDay = (date) => ({ date, runs: Object.fromEntries(METAL_IDS.map((id) => [id, 0])), NEW: 0, MOVED: 0, DROPPED: 0, LEFT: 0 });

export function formatHeartbeat(state, session, threshold) {
  const d = state?.day?.date === session ? state.day : emptyDay(session);
  const dead = METAL_IDS.filter((id) => !(d.runs?.[id] > 0));
  const last = state?.lastRunAt && d.date === session && !dead.length ? ` · last ${istTime(new Date(state.lastRunAt))}` : "";
  const runs = METAL_IDS.map((id) => `${METALS[id].emoji} ${d.runs?.[id] ?? 0}`).join("  ");
  const n = Object.keys(state?.tracked ?? {}).length;
  return [
    `${dead.length ? "⚠️" : "✓"} <b>${BRAND} alerts · end of day ${dm(session)}</b>`,
    `Runs checked: ${runs}${last}`,
    `${d.NEW} new, ${d.MOVED} moves, ${d.DROPPED + d.LEFT} exits · ${n} tracked now (CONV ≥ ${threshold})`,
    dead.length
      ? `\n${dead.map((id) => METALS[id].label).join(", ")} got no fresh data today — check the Actions tab (Refresh MCX data) and the Upstox token.`
      : "",
  ].join("\n").trimEnd();
}

// --- state bookkeeping ------------------------------------------------------

export function bumpDay(state, freshIds, events, session, nowIso) {
  const day = state.day?.date === session ? { ...state.day, runs: { ...state.day.runs } } : emptyDay(session);
  for (const id of freshIds) day.runs[id] = (day.runs[id] ?? 0) + 1;
  for (const e of events) day[e.kind] += 1;
  return { ...state, day, lastRunAt: nowIso };
}

/** Invented sample for `--mock`: every line type, one per metal. */
export function mockEvents() {
  const row = (id, expiry, strike, type, conviction, ltp, block = null) => {
    const m = METALS[id];
    const symbol = m.feedSymbol;
    const lot = lotLabel(m, symbol);
    const units = m.contracts.find((c) => c.symbol === symbol).quoteUnitsPerLot;
    return { metal: id, emoji: m.emoji, symbol, expiry, strike, type, conviction, ltp, unit: m.quoteUnit, lot, credit: Math.round(ltp * units), block };
  };
  return [
    { kind: "NEW", row: row("silver", "2026-10-27", 262000, "CE", 81, 1485.5) },
    { kind: "NEW", row: row("gold", "2026-10-29", 144000, "PE", 76, 612, "VRP negative — selling blocked") },
    { kind: "NEW", row: row("copper", "2026-10-23", 1360, "PE", 71, 4.35) },
    { kind: "DROPPED", from: 72, row: row("silver", "2026-10-27", 212000, "PE", 66, 1120) },
    { kind: "LEFT", from: 74, row: row("gold", "2026-10-29", 158000, "CE", 74, 410), why: "filtered out: inside the gamma zone (< 0.6σ)" },
    { kind: "MOVED", from: 73, row: row("silver", "2026-10-27", 216000, "PE", 75, 1310) },
    { kind: "MOVED", from: 78, row: row("copper", "2026-10-23", 1480, "CE", 77, 3.9) },
  ];
}

// --- one run ------------------------------------------------------------------

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

/**
 * One alert run over the snapshot files in `dataDir`, against the state file
 * in `stateDir`. `send` must throw when a message is not accepted — the state
 * is written only after every send has returned.
 */
export async function run({ dataDir, stateDir, now, threshold, send, log = console.log }) {
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
      threshold, today,
      isFresh: (t) => fresh.has(t.metal),
      explain: (t) => explainMissing(t, contexts[t.metal]),
    });
    state = { version: 1, ...(prev ?? {}), tracked, metals };
    // First ever run: announce the starting set in ONE message rather than a
    // loud NEW per contract — switching alerts on never floods, and nothing
    // already above the bar is swallowed either.
    const armed = !prev;
    const msgs = formatMessages(events, { threshold, when, armed });
    for (const m of msgs) await send(m);
    const tally = events.reduce((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {});
    log(armed
      ? `First run: armed, tracking ${Object.keys(tracked).length} contracts at CONV ≥ ${threshold}.`
      : `${events.length} events ${JSON.stringify(tally)}, ${Object.keys(tracked).length} tracked, ${msgs.length} message(s) sent.`);
    state = bumpDay(state, fresh, armed ? [] : events, session, now.toISOString());
  } else if (!prev) {
    log("No fresh metal snapshot and no state yet — arming waits for the first fresh in-session run.");
    return;
  }

  // End-of-day heartbeat: the first run after MCX's close (23:30 / 23:55 IST).
  // Its absence the next morning is how the owner learns the pipeline stopped.
  if (afterClose(now, session) && state.heartbeatDate !== session) {
    await send(formatHeartbeat(state, session, threshold));
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
  if (argv.includes("--mock")) {
    // Rendered by the real formatter so the owner sees exactly what a live
    // alert looks and sounds like. Contracts and prices are invented.
    const [m] = formatMessages(mockEvents(), { threshold: DEFAULT_THRESHOLD, when: istTime(new Date()) });
    await sendTelegram("🧪 <b>MOCK ALERT (test only, not real)</b>\n\n" + m);
    console.log("Mock alert sent.");
    return;
  }
  const envMin = Number(process.env.ALERT_MIN_CONV_METALS);
  await run({
    dataDir: process.env.ALERTS_DATA_DIR ?? "public/data",
    stateDir: process.env.ALERTS_STATE_DIR ?? "_alerts",
    now: process.env.ALERTS_NOW ? new Date(process.env.ALERTS_NOW) : new Date(),
    threshold: Number.isFinite(envMin) && envMin > 0 ? envMin : DEFAULT_THRESHOLD,
    send: sendTelegram,
  });
}
