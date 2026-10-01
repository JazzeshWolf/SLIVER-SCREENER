import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METALS, METAL_IDS } from "../src/lib/metals.mjs";
import {
  usDst, closeMinutes, inSession, sessionDate, afterClose, chainFingerprint, freshness,
  collectMetal, watchedExpiries, explainMissing, diff, formatMessages, formatEod, bumpDay,
  mockEvents, mockState, sendTelegram, run,
} from "./alerts.mjs";

const TODAY = "2026-10-14";
const row = (over = {}) => ({
  metal: "silver", emoji: "🥈", symbol: "SILVERM", expiry: "2026-10-27", dte: 13,
  strike: 262000, type: "CE", conviction: 72, ltp: 1485.5, unit: "₹/kg", lot: "5 kg", credit: 7428,
  rom: 4.9, pop: 0.93, displayed: true, ok: true, why: null, block: null, ...over,
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
    strike, type, conv, premium: 1000, credit: 5000.4, marginPerLot: 125010, pOtm: 0.93456, ok: true, reasons: [], ...over,
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
      rom: 4, pop: 0.9346, block: "VRP negative — selling blocked",
    });
    expect(rows.get("silver|2026-10-27|270000|CE")).toMatchObject({ displayed: false, ok: true });
    expect(rows.get("silver|2026-10-27|200000|PE")).toMatchObject({ ok: false, why: "prem decayed" });
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
    expect(explainMissing(row({ strike: 300000, type: "CE" }), context)).toMatch(/off the chain/);
    expect(explainMissing(row({ expiry: "2026-11-23" }), context)).toMatch(/expiry gone/);
    const thin = collectMetal("copper", { mcx: { symbol: "COPPER" } }, {
      expiries: [{ ...view.expiries[0], screen: { tooThin: true, candidates: [] }, shown: { CE: [], PE: [] } }],
    });
    expect(explainMissing(row({ metal: "copper" }), thin.context)).toMatch(/too thin/);
  });
});

describe("formatting", () => {
  const unpre = (m) => m.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  const preLines = (m) => [...m.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].flatMap((x) => unpre(x[1]).split("\n"));
  const opts = { threshold: 70, minDte: 10, when: "14:05", today: TODAY };
  const mock = () => mockEvents(TODAY);

  it("labels every message as MCX so it can't be mistaken for the NSE screener", () => {
    const [m] = formatMessages([{ kind: "NEW", row: row() }], opts);
    expect(m.startsWith("⚖️ <b>MCX</b> · 14:05 IST\n<i>Alert level: conviction 70+ · 10+ days to expiry</i>")).toBe(true);
    expect(formatMessages([{ kind: "NEW", row: row() }], { ...opts, minDte: 0 })[0]).toContain("<i>Alert level: conviction 70+</i>");
  });

  it("gives each commodity + expiry a card: bold header, days left and lot, then the gate", () => {
    const [m] = formatMessages(mock(), opts);
    expect(m).toContain("🥈 <b>SILVERM · 9 Nov</b>\n26 days left · lot 5 kg\n<pre>");
    // The gate is printed once, under its expiry's header.
    expect(m).toContain("🥇 <b>GOLDM · 11 Nov</b>\n28 days left · lot 100 g\n🔴 VRP negative — selling blocked\n<pre>");
    expect(m).toContain("🛢️ <b>CRUDEOILM · 28 Oct</b>\n14 days left · lot 10 bbl");
    const day = (expiry) => formatMessages([{ kind: "LEFT", from: 71, row: row({ expiry }), why: "x" }], opts)[0];
    expect(day("2026-10-15")).toContain("\n1 day left · lot 5 kg");
    expect(day(TODAY)).toContain("\nexpires today · lot 5 kg");
  });

  it("lays every section out in the Nifty alerts' columns: strike, CONV, PREM, ROM, POP", () => {
    const [m] = formatMessages(mock(), opts);
    const lines = preLines(m);
    expect(lines).toContain("NEW       CONV  PREM ROM POP");
    expect(lines).toContain("262000CE    81 1,486 4.9  93");
    expect(lines).toContain("216000PE 73→75 1,310 4.3  90");
    expect(lines).toContain("212000PE 72→66 1,120 3.7  88");
    expect(lines).toContain("205000PE  71→–   640 2.1  95");
    expect(lines).toContain("1360PE    71 4.35 12.4  90");
    // Every row of a card shares one set of widths, so the columns line up.
    const silver = preLines(m.slice(m.indexOf("SILVERM"), m.indexOf("GOLDM"))).filter(Boolean);
    expect(new Set(silver.map((l) => l.length)).size).toBe(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(34);
    // Emoji are wider than a monospace cell; they would break the columns.
    for (const l of lines) expect(l).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("titles exits by reason: DROPPED, ITM, GAMMA, DECAYED, REMOVED, EXPIRED", () => {
    const left = (strike, why, over = {}) => ({ kind: "LEFT", from: 72, row: row({ strike }), why, ...over });
    const [m] = formatMessages([
      { kind: "DROPPED", from: 72, row: row({ strike: 1, conviction: 66 }) },
      left(2, "in the money"), left(3, "gamma zone"), left(4, "prem decayed +1"), left(5, "off the chain"),
      left(6, "expires today", { expiring: true }),
    ], opts);
    const titles = preLines(m).filter((l) => /^[A-Z]/.test(l)).map((l) => l.split(" ")[0]);
    expect(titles).toEqual(["DROPPED", "ITM", "GAMMA", "DECAYED", "REMOVED", "EXPIRED"]);
    expect(m).toContain("ITM = now in the money · GAMMA = too close to the price · DECAYED = premium too small to hold");
    expect(formatMessages([{ kind: "NEW", row: row() }], opts)[0]).not.toContain("ITM =");
  });

  it("leads with fresh entries: cards holding a NEW first, highest CONV first; sections NEW, MOVED, exits", () => {
    const [m] = formatMessages(mock(), opts);
    const order = ["SILVERM", "GOLDM", "CRUDEOILM", "COPPER"].map((x) => m.indexOf(`<b>${x}`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const silver = unpre(m.slice(m.indexOf("SILVERM"), m.indexOf("GOLDM")));
    const at = (t) => silver.indexOf(`\n${t} `) >= 0 ? silver.indexOf(`\n${t} `) : silver.indexOf(`>${t} `);
    expect(at("NEW")).toBeLessThan(at("MOVED"));
    expect(at("MOVED")).toBeLessThan(at("DROPPED"));
    expect(at("DROPPED")).toBeLessThan(at("DECAYED"));
    // Without a NEW, commodity order then expiry.
    const [q] = formatMessages([
      { kind: "MOVED", from: 71, row: row({ metal: "gold", symbol: "GOLDM", conviction: 72 }) },
      { kind: "MOVED", from: 71, row: row({ expiry: "2026-11-26", conviction: 72 }) },
      { kind: "MOVED", from: 71, row: row({ conviction: 72 }) },
    ], opts);
    expect(q.indexOf("SILVERM · 27 Oct")).toBeLessThan(q.indexOf("SILVERM · 26 Nov"));
    expect(q.indexOf("SILVERM · 26 Nov")).toBeLessThan(q.indexOf("GOLDM"));
  });

  it("shows a dash for a ROM or POP it doesn't have (state written before they were kept)", () => {
    const [m] = formatMessages([{ kind: "LEFT", from: 71, row: row({ rom: undefined, pop: undefined }), why: "x" }], opts);
    expect(preLines(m)).toContain("262000CE 71→– 1,486   –   –");
  });

  it("explains PREM's unit for the contracts in the message, and the other columns", () => {
    const [m] = formatMessages(mock(), opts);
    expect(m).toContain("PREM ₹ per kg (SILVERM, COPPER) · per 10 g (GOLDM) · per bbl (CRUDEOILM)");
    expect(m).toContain("ROM % = credit per lot ÷ margin per lot (screener's estimate)");
    expect(m).toContain("POP % = model's chance it expires worthless");
    expect(m).toContain("DROPPED = fell below 70 · REMOVED = off the list");
    expect(m.endsWith('<a href="https://jazzeshwolf.github.io/SLIVER-SCREENER/">Open screener</a>')).toBe(true);
    expect(formatMessages([{ kind: "NEW", row: row() }], opts)[0]).toContain("<i>PREM ₹ per kg (SILVERM)\n");
  });

  it("escapes HTML and splits under Telegram's length cap without breaking a card", () => {
    const events = [
      ...Array.from({ length: 150 }, (_, i) => ({
        kind: "NEW", row: row({ strike: 200000 + i, expiry: i < 75 ? "2026-10-27" : "2026-11-23", block: "a < b & c" }),
      })),
      { kind: "LEFT", from: 71, row: row({ strike: 1, symbol: "X<Y" }), why: "x" },
    ];
    const msgs = formatMessages(events, opts);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(4096);
      expect(m.split("<pre>").length).toBe(m.split("</pre>").length);
    }
    expect(msgs[1].startsWith("⚖️ <b>MCX</b> · 14:05 IST (cont.)")).toBe(true);
    const all = msgs.join("");
    expect(all).toContain("a &lt; b &amp; c");
    expect(all).toContain("X&lt;Y");
    expect(msgs.flatMap(preLines).filter((l) => / 72 1,486 4\.9 {2}93$/.test(l))).toHaveLength(150);
  });

  it("arming lists the starting set, and says so when it is empty", () => {
    const armed = formatMessages([{ kind: "NEW", row: row() }], { ...opts, armed: true });
    expect(armed[0]).toContain("✅ Alerts armed — already above the bar, now tracked (1)");
    expect(armed[0]).toContain("262000CE");
    const empty = formatMessages([], { ...opts, armed: true })[0];
    expect(empty).toContain("nothing above the bar right now");
    expect(empty).not.toContain("ROM %"); // no legend for a table that isn't there
    expect(formatMessages([], opts)).toEqual([]);
  });

  it("the mock goes through the real formatter and shows every commodity and gate", () => {
    const [m] = formatMessages(mock(), opts);
    for (const mark of ["🥈", "🥇", "🟠", "🛢️", "🔴", ">NEW ", "MOVED ", "DROPPED ", "GAMMA ", "DECAYED "]) expect(m).toContain(mark);
  });
});

describe("end of day", () => {
  const unpre = (m) => m.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  const ev = (metal, kind) => ({ kind, row: { metal } });

  it("opens with a per-commodity table of runs, new, moves, exits and tracked now", () => {
    const tracked = { a: row(), b: row({ strike: 1 }), c: row({ metal: "gold", symbol: "GOLDM" }) };
    const s = bumpDay({ tracked }, METAL_IDS, [ev("silver", "NEW"), ev("gold", "LEFT"), ev("gold", "DROPPED")],
      "2026-09-24", "2026-09-24T17:50:00Z");
    const [m] = formatEod(s, "2026-09-24", 70);
    expect(m.startsWith("📋 <b>MCX · end of day 24 Sep</b>\n<pre>")).toBe(true);
    const t = unpre(m);
    expect(t).toContain("          Runs New Moves Exits Now");
    expect(t).toContain("Silver       1   1     0     0   2");
    expect(t).toContain("Gold         1   0     0     2   1");
    expect(t).toContain("Crude Oil    1   0     0     0   0");
    expect(m).toContain("Last run: 23:20 IST");
  });

  it("lists what is still at the bar at the close as cards, and says None when nothing is", () => {
    const tracked = {
      a: row({ conviction: 74 }), b: row({ strike: 270000, conviction: 81 }),
      old: row({ expiry: "2026-09-23" }), // expired before this session: not at the close
    };
    const s = bumpDay({ tracked }, METAL_IDS, [], "2026-09-24", "2026-09-24T17:50:00Z");
    const [m] = formatEod(s, "2026-09-24", 70);
    expect(m).toContain("⚖️ <b>At 70+ at the close (2)</b>\n\n🥈 <b>SILVERM · 27 Oct</b>\n33 days left · lot 5 kg\n<pre>ABOVE");
    expect(unpre(m)).toMatch(/270000CE +81[\s\S]*262000CE +74/);
    const [none] = formatEod(bumpDay({ tracked: {} }, METAL_IDS, [], "2026-09-24", "2026-09-24T17:50:00Z"), "2026-09-24", 70);
    expect(none).toContain("⚖️ <b>At 70+ at the close (0)</b>\nNone.");
    expect(none).not.toContain("ROM %");
  });

  it("warns, by name, when a commodity got no fresh data", () => {
    const partial = bumpDay({ tracked: {} }, ["silver", "gold", "crude"], [], "2026-09-24", "2026-09-24T17:50:00Z");
    expect(formatEod(partial, "2026-09-24", 70)[0]).toMatch(/^⚠️ <b>MCX · end of day[\s\S]*Copper got no fresh data/);
    expect(formatEod(null, "2026-09-24", 70)[0]).toMatch(/Silver, Gold, Copper, Crude Oil got no fresh data[\s\S]*Last run: — IST|Last run: — IST[\s\S]*Silver, Gold, Copper, Crude Oil/);
  });

  it("the mock end of day shows every commodity", () => {
    const [m] = formatEod(mockState(TODAY), TODAY, 70);
    expect(m.startsWith("📋")).toBe(true);
    for (const mark of ["🥈", "🥇", "🟠", "🛢️", "At 70+ at the close (7)"]) expect(m).toContain(mark);
  });

  it("counts a day's runs and events per metal, per session", () => {
    let s = bumpDay({}, ["silver"], [ev("silver", "NEW"), ev("silver", "MOVED")], "2026-09-24", "x");
    s = bumpDay(s, ["silver", "gold"], [ev("gold", "MOVED")], "2026-09-24", "y");
    expect(s.day.runs).toEqual({ silver: 2, gold: 1, copper: 0, crude: 0 });
    expect(s.day.events.silver).toMatchObject({ NEW: 1, MOVED: 1 });
    expect(s.day.events.gold).toMatchObject({ MOVED: 1 });
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
    expect(sent[1]).toMatch(/^📋 <b>MCX · end of day 24 Sep<\/b>/);
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
