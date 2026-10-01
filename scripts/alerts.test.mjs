import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METALS, METAL_IDS } from "../src/lib/metals.mjs";
import {
  usDst, closeMinutes, inSession, sessionDate, afterClose, chainFingerprint, freshness,
  collectMetal, watchedExpiries, explainMissing, diff, formatMessages, formatHeartbeat, bumpDay, tierMark,
  mockEvents, sendTelegram, run,
} from "./alerts.mjs";

const TODAY = "2026-10-14";
const row = (over = {}) => ({
  metal: "silver", emoji: "🥈", symbol: "SILVERM", expiry: "2026-10-27", dte: 13,
  strike: 262000, type: "CE", conviction: 72, ltp: 1485.5, unit: "₹/kg", lot: "5 kg", credit: 7428,
  displayed: true, ok: true, why: null, block: null, ...over,
});
const k = (r) => `${r.metal}|${r.expiry}|${r.strike}|${r.type}`;
const cur = (...rows) => new Map(rows.map((r) => [k(r), r]));
const always = () => true;
const diffAt = (tracked, current, over = {}) =>
  diff(tracked, current, { threshold: 70, today: TODAY, isFresh: always, ...over });
const at = (iso) => new Date(iso);

describe("MCX session clock", () => {
  it("follows US daylight saving (2nd Sun Mar → 1st Sun Nov)", () => {
    expect(usDst("2026-03-06")).toBe(false);
    expect(usDst("2026-03-09")).toBe(true); // Monday after 8 Mar
    expect(usDst("2026-10-30")).toBe(true);
    expect(usDst("2026-11-02")).toBe(false); // Monday after 1 Nov
  });

  it("closes 23:30 IST in US summer, 23:55 IST in US winter", () => {
    expect(closeMinutes("2026-09-25")).toBe(23 * 60 + 30);
    expect(closeMinutes("2026-12-01")).toBe(23 * 60 + 55);
  });

  it("is open 09:00 to the close, weekdays only", () => {
    expect(inSession(at("2026-09-25T03:30:00Z"))).toBe(true); // Fri 09:00 IST
    expect(inSession(at("2026-09-25T03:29:00Z"))).toBe(false); // 08:59
    expect(inSession(at("2026-09-25T17:59:00Z"))).toBe(true); // 23:29
    expect(inSession(at("2026-09-25T18:00:00Z"))).toBe(false); // 23:30
    expect(inSession(at("2026-12-01T18:20:00Z"))).toBe(true); // 23:50 in winter
    expect(inSession(at("2026-09-26T06:00:00Z"))).toBe(false); // Saturday
  });

  it("files a small-hours run under the previous session, and weekends under Friday", () => {
    expect(sessionDate(at("2026-09-22T20:30:00Z"))).toBe("2026-09-22"); // Wed 02:00 IST → Tue
    expect(sessionDate(at("2026-09-26T06:00:00Z"))).toBe("2026-09-25"); // Sat → Fri
    expect(sessionDate(at("2026-09-27T21:00:00Z"))).toBe("2026-09-25"); // Mon 02:30 IST → Fri
    expect(sessionDate(at("2026-09-24T08:30:00Z"))).toBe("2026-09-24");
  });

  it("knows when a session has closed", () => {
    expect(afterClose(at("2026-09-24T17:59:00Z"), "2026-09-24")).toBe(false); // 23:29
    expect(afterClose(at("2026-09-24T18:00:00Z"), "2026-09-24")).toBe(true); // 23:30
    expect(afterClose(at("2026-09-24T20:30:00Z"), "2026-09-24")).toBe(true); // 02:00 next day
    expect(afterClose(at("2026-12-01T18:20:00Z"), "2026-12-01")).toBe(false); // 23:50 winter
  });
});

describe("freshness", () => {
  const chain = [{ strike: 250000, type: "CE", ltp: 1200, oi: 900 }];
  const snap = (over = {}) => ({
    stale: false, live: {}, mcx: { fut: 236000 }, options: { chain },
    expiries: [{ optionExpiry: "2026-10-27", fut: 236000, chain }],
    feed: { chainOk: true, lastLiveAt: "2026-09-25T08:40:00Z" }, ...over,
  });

  it("accepts a live chain captured in session that moved past the last run", () => {
    expect(freshness(snap(), { lastLiveAt: "2026-09-25T05:00:00Z" })).toMatchObject({ fresh: true });
    expect(freshness(snap())).toMatchObject({ fresh: true }); // no history yet
  });

  it("rejects stale, chainless, repeated, after-hours and unchanged snapshots", () => {
    expect(freshness(null).fresh).toBe(false);
    expect(freshness(snap({ stale: true })).why).toMatch(/stale/);
    expect(freshness(snap({ live: undefined })).why).toMatch(/macro/);
    // The builder bumps asOf even when Upstox failed; chainOk is the tell.
    expect(freshness(snap({ feed: { chainOk: false, lastLiveAt: "2026-09-25T08:40:00Z" } })).why).toMatch(/no live option chain/);
    expect(freshness(snap(), { lastLiveAt: "2026-09-25T08:40:00Z" }).why).toMatch(/not newer/);
    expect(freshness(snap({ feed: { chainOk: true, lastLiveAt: "2026-09-25T20:30:00Z" } })).why).toMatch(/outside MCX hours/);
    const fp = chainFingerprint(snap());
    expect(freshness(snap(), { lastLiveAt: "2026-09-25T05:00:00Z", fingerprint: fp }).why).toMatch(/unchanged/);
  });

  it("fingerprints prices and OI, not timestamps", () => {
    const moved = [{ ...chain[0], ltp: 1201 }];
    expect(chainFingerprint(snap())).toBe(chainFingerprint(snap({ feed: { chainOk: true, lastLiveAt: "x" } })));
    expect(chainFingerprint(snap())).not.toBe(chainFingerprint(snap({ expiries: [{ optionExpiry: "2026-10-27", fut: 236000, chain: moved }] })));
  });
});

describe("diff", () => {
  it("announces a displayed contract crossing the threshold, once", () => {
    const r = row();
    const a = diffAt({}, cur(r));
    expect(a.events.map((e) => e.kind)).toEqual(["NEW"]);
    expect(diffAt(a.tracked, cur(r)).events).toEqual([]); // same CONV next run → silence
  });

  it("never starts tracking a strike the Sell tab does not show", () => {
    expect(diffAt({}, cur(row({ displayed: false, conviction: 90 }))).events).toEqual([]);
    expect(diffAt({}, cur(row({ ok: false, conviction: 90 }))).events).toEqual([]);
  });

  it("reports every point of movement while above the bar, both directions", () => {
    const { tracked } = diffAt({}, cur(row({ conviction: 70 })));
    const up = diffAt(tracked, cur(row({ conviction: 71 })));
    expect(up.events).toMatchObject([{ kind: "MOVED", from: 70, row: { conviction: 71 } }]);
    const down = diffAt(up.tracked, cur(row({ conviction: 70 })));
    expect(down.events).toMatchObject([{ kind: "MOVED", from: 71 }]);
  });

  it("reports the drop below the bar and stops tracking; a re-cross is NEW again", () => {
    const { tracked } = diffAt({}, cur(row({ conviction: 70 })));
    const d = diffAt(tracked, cur(row({ conviction: 69 })));
    expect(d.events).toMatchObject([{ kind: "DROPPED", from: 70, row: { conviction: 69 } }]);
    expect(d.tracked).toEqual({});
    expect(diffAt(d.tracked, cur(row({ conviction: 71 }))).events[0].kind).toBe("NEW");
  });

  it("keeps following a tracked strike that slipped below the top 8", () => {
    const { tracked } = diffAt({}, cur(row({ conviction: 72 })));
    const d = diffAt(tracked, cur(row({ conviction: 73, displayed: false })));
    expect(d.events).toMatchObject([{ kind: "MOVED", from: 72 }]);
    expect(Object.keys(d.tracked)).toHaveLength(1);
  });

  it("reports LEFT with the filter's reason when a tracked strike is rejected", () => {
    const { tracked } = diffAt({}, cur(row()));
    const d = diffAt(tracked, cur(row({ ok: false, why: "filtered out: inside the gamma zone (< 0.6σ)" })));
    expect(d.events).toMatchObject([{ kind: "LEFT", from: 72, why: "filtered out: inside the gamma zone (< 0.6σ)" }]);
    expect(d.tracked).toEqual({});
  });

  it("reports LEFT, explained, when a tracked strike is gone from the scored set", () => {
    const { tracked } = diffAt({}, cur(row()));
    const d = diffAt(tracked, new Map(), { explain: () => "now in the money (future 263000)" });
    expect(d.events).toMatchObject([{ kind: "LEFT", expiring: false, why: "now in the money (future 263000)" }]);
  });

  it("holds silently when the metal got no fresh data this run", () => {
    const { tracked } = diffAt({}, cur(row()));
    const d = diffAt(tracked, new Map(), { isFresh: () => false });
    expect(d.events).toEqual([]);
    expect(d.tracked).toEqual(tracked);
  });

  it("drops expired contracts without a message, even on a held run", () => {
    const { tracked } = diffAt({}, cur(row({ expiry: "2026-10-15" })), { today: "2026-10-14" });
    expect(diffAt(tracked, new Map(), { today: "2026-10-16" })).toEqual({ events: [], tracked: {} });
    expect(diffAt(tracked, new Map(), { today: "2026-10-16", isFresh: () => false }).tracked).toEqual({});
  });

  it("flags a contract that vanishes on its expiry day as expiring", () => {
    const { tracked } = diffAt({}, cur(row({ expiry: TODAY })));
    expect(diffAt(tracked, new Map()).events[0]).toMatchObject({ kind: "LEFT", expiring: true, why: "expires today" });
  });

  it("orders entries and exits before drift", () => {
    const a = row({ strike: 260000, conviction: 71 });
    const b = row({ strike: 262000, conviction: 74 });
    const { tracked } = diffAt({}, cur(a, b));
    const d = diffAt(tracked, cur(row({ strike: 260000, conviction: 72 }), row({ strike: 264000, conviction: 75 })));
    expect(d.events.map((e) => e.kind)).toEqual(["NEW", "LEFT", "MOVED"]);
  });

  it("needs 10+ days to expiry to start tracking, then follows the strike to its exit", () => {
    const at = (dte, conviction = 72) => cur(row({ dte, conviction }));
    expect(diffAt({}, at(9), { minDte: 10 }).events).toEqual([]);
    const a = diffAt({}, at(10), { minDte: 10 });
    expect(a.events.map((e) => e.kind)).toEqual(["NEW"]);
    // Days pass: under 10 left, still tracked — moves and the exit are reported.
    const b = diffAt(a.tracked, at(6, 75), { minDte: 10 });
    expect(b.events).toMatchObject([{ kind: "MOVED", from: 72, row: { conviction: 75 } }]);
    const c = diffAt(b.tracked, at(5, 60), { minDte: 10 });
    expect(c.events).toMatchObject([{ kind: "DROPPED" }]);
    // …and a re-cross with too few days left stays quiet.
    expect(diffAt(c.tracked, at(4, 80), { minDte: 10 }).events).toEqual([]);
  });

  it("keeps metals apart: the same strike on two metals is two contracts", () => {
    const d = diffAt({}, cur(row(), row({ metal: "gold", symbol: "GOLDM" })));
    expect(Object.keys(d.tracked)).toHaveLength(2);
  });
});

describe("collectMetal", () => {
  const cand = (strike, type, conv, over = {}) => ({
    strike, type, conv, premium: 1000, credit: 5000.4, ok: true, reasons: [], ...over,
  });
  const gates = (blocked = false) => ({ blocked, vrp: { blocked }, events: { vetoed: false } });
  const view = {
    expiries: [{
      optionExpiry: "2026-10-27", optionDte: 32, fut: 236000,
      screen: { tooThin: false, candidates: [cand(262000, "CE", 81), cand(270000, "CE", 40), cand(200000, "PE", 90, { ok: false, reasons: ["tinyPrem"] })] },
      shown: { CE: [cand(262000, "CE", 81)], PE: [] },
      gates: gates(true),
    }],
  };
  const snap = { mcx: { symbol: "SILVERM" } };

  it("flags the displayed list, keeps the rest scored, and carries the lot and gate", () => {
    const { rows } = collectMetal("silver", snap, view);
    expect(rows.get("silver|2026-10-27|262000|CE")).toMatchObject({
      displayed: true, ok: true, conviction: 81, lot: "5 kg", credit: 5000, unit: "₹/kg",
      block: "VRP negative — selling blocked",
    });
    expect(rows.get("silver|2026-10-27|270000|CE")).toMatchObject({ displayed: false, ok: true });
    expect(rows.get("silver|2026-10-27|200000|PE")).toMatchObject({ ok: false, why: expect.stringMatching(/premium decayed/) });
  });

  it("reads GOLDM's lot as 100 g (credit is already premium × 10)", () => {
    const { rows } = collectMetal("gold", { mcx: { symbol: "GOLDM" } }, view);
    expect([...rows.values()][0]).toMatchObject({ lot: "100 g", symbol: "GOLDM", emoji: "🥇", unit: "₹/10g" });
  });

  it("watches the current and next expiry only; a DTE-0 expiry gives up its slot", () => {
    const ex = (optionExpiry, optionDte) => ({ ...view.expiries[0], optionExpiry, optionDte });
    const pick = (...es) => watchedExpiries({ expiries: es }).map((e) => e.optionExpiry);
    expect(pick(ex("2026-11-27", 63), ex("2026-10-29", 34), ex("2026-12-29", 95))).toEqual(["2026-10-29", "2026-11-27"]);
    // Gold on 25 Sep: that day's expiry is done, so October and November are watched.
    expect(pick(ex("2026-09-25", 0), ex("2026-10-29", 34), ex("2026-11-27", 63))).toEqual(["2026-10-29", "2026-11-27"]);
    const { rows } = collectMetal("gold", { mcx: { symbol: "GOLDM" } }, {
      expiries: [ex("2026-10-29", 34), ex("2026-11-27", 63), ex("2026-12-29", 95)],
    });
    expect(new Set([...rows.values()].map((r) => r.expiry))).toEqual(new Set(["2026-10-29", "2026-11-27"]));
  });

  it("explains a missing strike from the expiry's context", () => {
    const { context } = collectMetal("silver", snap, view);
    expect(explainMissing(row({ strike: 230000, type: "CE" }), context)).toMatch(/in the money/);
    expect(explainMissing(row({ strike: 300000, type: "CE" }), context)).toMatch(/dropped off/);
    expect(explainMissing(row({ expiry: "2026-11-23" }), context)).toMatch(/no longer listed/);
    const thin = collectMetal("copper", { mcx: { symbol: "COPPER" } }, {
      expiries: [{ ...view.expiries[0], screen: { tooThin: true, candidates: [] }, shown: { CE: [], PE: [] } }],
    });
    expect(explainMissing(row({ metal: "copper" }), thin.context)).toMatch(/too thin/);
  });
});

describe("formatting", () => {
  // The card layout is the Xerxes one (owner's ask, 2026-10-01).
  const pre = (m) => m.slice(m.indexOf("<pre>") + 5, m.indexOf("</pre>")).split("\n");
  const opts = { threshold: 70, when: "14:05", today: TODAY };

  it("marks tiers at 75 and 80", () => {
    expect(tierMark(80)).toBe("🔥");
    expect(tierMark(76)).toBe("⭐");
    expect(tierMark(72)).toBe("");
  });

  it("heads every message ⚖️ MCX and every card with the metal's emoji and contract", () => {
    const [m] = formatMessages([{ kind: "NEW", row: row({ margin: 185000, pop: 0.93 }) }], opts);
    expect(m.startsWith("⚖️ <b>MCX")).toBe(true);
    expect(m).toContain("<b>🥈 SILVERM · 27 Oct</b>\nMonthly · 13 days left · lot 5 kg\n<pre>");
    expect(pre(m)).toEqual([
      "NEW      CONV  PREM ROM POP",
      "262000CE   72 1,486 4.0  93",
    ]);
  });

  it("shows ROM as credit ÷ the screen's margin, and POP as the chance it expires worthless", () => {
    // Crude's 7500 PE from the owner's Sensibull: ₹553 credit on ₹27,392 → 2.0%.
    const r = row({ metal: "crude", emoji: "🛢️", symbol: "CRUDEOILM", expiry: "2026-10-15", strike: 7500, type: "PE",
      conviction: 56, ltp: 55.25, unit: "₹/bbl", lot: "10 bbl", credit: 553, margin: 27392, pop: 0.912 });
    const [m] = formatMessages([{ kind: "NEW", row: r }], opts);
    expect(m).toContain("<b>🛢️ CRUDEOILM · 15 Oct</b>\nMonthly · 1 day left · lot 10 bbl");
    expect(pre(m)[1]).toBe("7500PE   56 55.25 2.0  91");
    // No margin or POP on record (an older tracked entry): a dash, never NaN.
    const [old] = formatMessages([{ kind: "LEFT", from: 74, row: row(), why: "dropped off the fetched chain" }], opts);
    expect(pre(old)[1]).toBe("262000CE 74→– 1,486   –   –");
  });

  it("states the rule under the header and the days left on the card", () => {
    const [m] = formatMessages([{ kind: "NEW", row: row({ dte: 32 }) }], { ...opts, minDte: 10 });
    expect(m).toContain("<i>Alert level: conviction 70+ · entry 10+ days left</i>");
    expect(m).toContain("13 days left");
    const s = bumpDay({ tracked: {} }, METAL_IDS, [], "2026-09-24", "2026-09-24T17:50:00Z");
    expect(formatHeartbeat(s, "2026-09-24", 70, 10)).toContain("(CONV ≥ 70, entry 10+ days left)");
  });

  it("splits a card into NEW / MOVED / DROPPED / REMOVED / EXPIRED sections on one grid", () => {
    const events = [
      { kind: "NEW", row: row({ strike: 262000, conviction: 81 }) },
      { kind: "MOVED", from: 73, row: row({ strike: 216000, type: "PE", conviction: 75, ltp: 1310 }) },
      { kind: "DROPPED", from: 72, row: row({ strike: 212000, type: "PE", conviction: 66, ltp: 1120 }) },
      { kind: "LEFT", from: 74, row: row({ strike: 270000 }), why: "now in the money (future 271000)" },
      { kind: "LEFT", from: 71, row: row({ strike: 275000 }), expiring: true, why: "expires today" },
    ];
    const [m] = formatMessages(events, opts);
    const lines = pre(m);
    expect(lines.filter((l) => /^[A-Z]+ +CONV/.test(l)).map((l) => l.split(" ")[0]))
      .toEqual(["NEW", "MOVED", "DROPPED", "REMOVED", "EXPIRED"]);
    expect(lines).toContain("216000PE 73→75 1,310   –   – ⭐");
    expect(lines).toContain("262000CE    81 1,486   –   – 🔥");
    // Every row and section head on the grid ends at the same column (tier
    // emoji, the only thing allowed past it, are trimmed off first).
    const widths = new Set(lines.filter(Boolean).map((l) => l.replace(/ [⭐🔥]$/u, "").length));
    expect(widths.size).toBe(1);
    // The reason a strike was removed rides under the table; an expiry doesn't need one.
    expect(m).toContain("</pre>\n<i>270000CE: now in the money (future 271000)</i>");
    expect(m).not.toContain("275000CE: expires today");
  });

  it("gives each contract and expiry its own card, cards with a NEW first", () => {
    const events = [
      { kind: "MOVED", from: 70, row: row({ expiry: "2026-10-27", strike: 250000, conviction: 72 }) },
      { kind: "NEW", row: row({ metal: "copper", emoji: "🟠", symbol: "COPPER", expiry: "2026-10-23", strike: 1360, type: "PE", conviction: 71, ltp: 4.35 }) },
      { kind: "NEW", row: row({ expiry: "2026-11-23", strike: 270000, conviction: 78 }) },
    ];
    const [m] = formatMessages(events, opts);
    const heads = [...m.matchAll(/<b>(.+? · \d+ \w+)<\/b>/g)].map((x) => x[1]);
    expect(heads).toEqual(["🥈 SILVERM · 23 Nov", "🟠 COPPER · 23 Oct", "🥈 SILVERM · 27 Oct"]);
  });

  it("puts the 🔴 gate on the card that it blocks", () => {
    const [m] = formatMessages([{ kind: "NEW", row: row({ block: "VRP negative — selling blocked" }) }], opts);
    expect(m).toContain("lot 5 kg\n🔴 VRP negative — selling blocked\n<pre>");
  });

  it("escapes HTML and splits under Telegram's length cap without breaking a table", () => {
    const events = Array.from({ length: 200 }, (_, i) => ({
      kind: "NEW", row: row({ strike: 200000 + i, block: "a < b & c" }),
    }));
    const msgs = formatMessages(events, opts);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(4096);
      expect((m.match(/<pre>/g) ?? []).length).toBe((m.match(/<\/pre>/g) ?? []).length);
    }
    expect(msgs[0]).toContain("a &lt; b &amp; c");
    expect(msgs.join("\n").match(/^200\d\d\dCE /gm)).toHaveLength(200);
  });

  it("arming lists the starting set, and says so when it is empty", () => {
    const armed = formatMessages([{ kind: "NEW", row: row() }], { ...opts, armed: true });
    expect(armed[0]).toContain("Alerts armed");
    expect(armed[0]).toContain("262000CE");
    expect(formatMessages([], { ...opts, armed: true })[0]).toContain("nothing above the bar");
    expect(formatMessages([], opts)).toEqual([]);
  });

  it("the mock goes through the real formatter and shows every section and commodity", () => {
    const [m] = formatMessages(mockEvents(), opts);
    for (const mark of ["NEW ", "MOVED ", "DROPPED ", "REMOVED ", "🥈 SILVERM", "🥇 GOLDM", "🟠 COPPER", "🛢️ CRUDEOILM", "🔴", "⭐", "🔥"]) {
      expect(m).toContain(mark);
    }
  });

  it("prices a crude line per barrel on the mini's 10 bbl lot", () => {
    const [m] = formatMessages(mockEvents().filter((e) => e.row.metal === "crude"), opts);
    expect(m).toContain("<b>🛢️ CRUDEOILM · 15 Oct</b>");
    expect(m).toContain("lot 10 bbl");
    expect(m).toContain("7500PE");
    expect(m).toContain("PREM ₹ per kg / 10g / bbl");
  });

  it("heartbeat warns, by name, when a metal got no fresh data", () => {
    const s = bumpDay({ tracked: {} }, METAL_IDS, [], "2026-09-24", "2026-09-24T17:50:00Z");
    expect(formatHeartbeat(s, "2026-09-24", 70)).toMatch(/^✓/);
    expect(formatHeartbeat(s, "2026-09-24", 70)).toContain("🛢️ 1");
    const partial = bumpDay({ tracked: {} }, ["silver", "gold", "crude"], [], "2026-09-24", "2026-09-24T17:50:00Z");
    const hb = formatHeartbeat(partial, "2026-09-24", 70);
    expect(hb).toMatch(/^⚠️/);
    expect(hb).toContain("Copper got no fresh data");
    // A crude feed that never comes up is exactly what this tripwire is for.
    const noCrude = bumpDay({ tracked: {} }, ["silver", "gold", "copper"], [], "2026-09-24", "2026-09-24T17:50:00Z");
    expect(formatHeartbeat(noCrude, "2026-09-24", 70)).toContain("Crude Oil got no fresh data");
    expect(formatHeartbeat(null, "2026-09-24", 70)).toMatch(/Silver, Gold, Copper, Crude Oil/);
  });

  it("counts a day's events per session", () => {
    let s = bumpDay({}, ["silver"], [{ kind: "NEW" }, { kind: "MOVED" }], "2026-09-24", "x");
    s = bumpDay(s, ["silver", "gold"], [{ kind: "MOVED" }], "2026-09-24", "y");
    expect(s.day).toMatchObject({ runs: { silver: 2, gold: 1, copper: 0 }, NEW: 1, MOVED: 2 });
    expect(bumpDay(s, [], [], "2026-09-25", "z").day.runs.silver).toBe(0);
  });
});

describe("sendTelegram", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("always rings, speaks HTML, and never leaks the token when rejected", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:SECRET");
    vi.stubEnv("TELEGRAM_CHAT_ID", "42");
    const fetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: "Unauthorized" }) }));
    vi.stubGlobal("fetch", fetch);
    const err = await sendTelegram("hi").catch((e) => e);
    expect(err.message).toContain("401");
    expect(err.message).not.toContain("SECRET");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ chat_id: "42", text: "hi", parse_mode: "HTML" });
    expect(body).not.toHaveProperty("disable_notification");
  });
});

// End to end over the real snapshots in public/data, pinned to "a fresh
// in-session chain" so the test does not depend on what the cron last wrote.
describe("run", () => {
  const IN_SESSION = "2026-09-24T08:40:00Z"; // Thu 14:10 IST
  function setup(lastLiveAt = IN_SESSION) {
    const root = mkdtempSync(join(tmpdir(), "alerts-test-"));
    for (const id of METAL_IDS) {
      // A commodity with no archived snapshot yet (crude, until the cron first
      // builds one) borrows copper's chain under its own contract, so the run
      // still sees every commodity fresh and the heartbeat can come back ✓.
      const file = existsSync(`public/data/${id}.json`) ? id : "copper";
      const s = JSON.parse(readFileSync(`public/data/${file}.json`, "utf8"));
      s.mcx = { ...s.mcx, symbol: METALS[id].feedSymbol };
      s.stale = false;
      s.feed = { ...(s.feed ?? {}), chainOk: true, lastLiveAt };
      writeFileSync(join(root, `${id}.json`), JSON.stringify(s));
    }
    return { dataDir: root, stateDir: join(root, "state"), root };
  }
  const go = (dirs, now, send, threshold = 70) =>
    run({ ...dirs, now: new Date(now), threshold, send, log: () => {} });

  it("arms once, then stays quiet on a snapshot it has already seen", async () => {
    const dirs = setup();
    const sent = [];
    await go(dirs, "2026-09-24T08:41:00Z", async (m) => sent.push(m));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Alerts armed");
    const state = JSON.parse(readFileSync(join(dirs.stateDir, "metals.json"), "utf8"));
    expect(state.day).toMatchObject({ date: "2026-09-24", runs: { silver: 1, gold: 1, copper: 1, crude: 1 } });
    expect(state.metals.silver.lastLiveAt).toBe(IN_SESSION);

    await go(dirs, "2026-09-24T08:51:00Z", async (m) => sent.push(m));
    expect(sent).toHaveLength(1);
    rmSync(dirs.root, { recursive: true, force: true });
  });

  it("writes no state when Telegram refuses, so the next run re-sends", async () => {
    const dirs = setup();
    const refuse = async () => {
      throw new Error("Telegram rejected the message: 500");
    };
    await expect(go(dirs, "2026-09-24T08:41:00Z", refuse)).rejects.toThrow(/rejected/);
    expect(existsSync(join(dirs.stateDir, "metals.json"))).toBe(false);
    rmSync(dirs.root, { recursive: true, force: true });
  });

  it("sends the heartbeat once, on the first run after the close", async () => {
    const dirs = setup();
    const sent = [];
    await go(dirs, "2026-09-24T08:41:00Z", async (m) => sent.push(m));
    await go(dirs, "2026-09-24T20:30:00Z", async (m) => sent.push(m)); // Fri 02:00 IST
    await go(dirs, "2026-09-24T21:30:00Z", async (m) => sent.push(m));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/^✓ <b>⚖️ MCX alerts · end of day 24 Sep/);
    rmSync(dirs.root, { recursive: true, force: true });
  });

  it("does not arm on data captured after hours", async () => {
    const dirs = setup("2026-09-24T19:00:00Z"); // 00:30 IST
    const sent = [];
    await go(dirs, "2026-09-24T19:01:00Z", async (m) => sent.push(m));
    expect(sent).toEqual([]);
    expect(existsSync(join(dirs.stateDir, "metals.json"))).toBe(false);
    rmSync(dirs.root, { recursive: true, force: true });
  });
});
