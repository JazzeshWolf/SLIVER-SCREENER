import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  usDst, closeMinutes, inSession, sessionDate, afterClose, chainFingerprint, freshness,
  collectMetal, explainMissing, diff, formatMessages, formatHeartbeat, bumpDay, tierMark,
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
  it("marks tiers at 75 and 80", () => {
    expect(tierMark(80)).toBe("🔥");
    expect(tierMark(76)).toBe("⭐");
    expect(tierMark(72)).toBe("");
  });

  it("labels every message as MCX so it can't be mistaken for the NSE screener", () => {
    const [m] = formatMessages([{ kind: "NEW", row: row() }], { threshold: 70, when: "14:05" });
    expect(m.startsWith("<b>⚖️ MCX")).toBe(true);
    expect(m).toContain("SILVERM 262000 CE");
    expect(m).toContain("27 Oct");
    expect(m).toContain("lot 5 kg");
    expect(m).toContain("credit ₹7,428/lot");
    expect(m).toContain("₹1,485.50/kg");
  });

  it("escapes HTML and splits under Telegram's length cap", () => {
    const events = Array.from({ length: 80 }, (_, i) => ({
      kind: "NEW", row: row({ strike: 200000 + i, block: "a < b & c" }),
    }));
    const msgs = formatMessages(events, { threshold: 70, when: "10:40" });
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(4096);
    expect(msgs[0]).toContain("a &lt; b &amp; c");
    expect(msgs.join("").match(/🔔 NEW/g)).toHaveLength(80);
  });

  it("arming lists the starting set, and says so when it is empty", () => {
    const armed = formatMessages([{ kind: "NEW", row: row() }], { threshold: 70, when: "09:20", armed: true });
    expect(armed[0]).toContain("Alerts armed");
    expect(armed[0]).toContain("SILVERM 262000 CE");
    expect(formatMessages([], { threshold: 70, when: "09:20", armed: true })[0]).toContain("Nothing above the bar");
    expect(formatMessages([], { threshold: 70, when: "09:20" })).toEqual([]);
  });

  it("the mock goes through the real formatter and shows every line type", () => {
    const [m] = formatMessages(mockEvents(), { threshold: 70, when: "14:05" });
    for (const mark of ["🔔 NEW", "🔻", "🚪", "⬆️", "⬇️", "🥈", "🥇", "🟠", "🔴"]) expect(m).toContain(mark);
  });

  it("heartbeat warns, by name, when a metal got no fresh data", () => {
    const s = bumpDay({ tracked: {} }, ["silver", "gold", "copper"], [], "2026-09-24", "2026-09-24T17:50:00Z");
    expect(formatHeartbeat(s, "2026-09-24", 70)).toMatch(/^✓/);
    const partial = bumpDay({ tracked: {} }, ["silver", "gold"], [], "2026-09-24", "2026-09-24T17:50:00Z");
    const hb = formatHeartbeat(partial, "2026-09-24", 70);
    expect(hb).toMatch(/^⚠️/);
    expect(hb).toContain("Copper got no fresh data");
    expect(formatHeartbeat(null, "2026-09-24", 70)).toMatch(/Silver, Gold, Copper/);
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
    for (const id of ["silver", "gold", "copper"]) {
      const s = JSON.parse(readFileSync(`public/data/${id}.json`, "utf8"));
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
    expect(state.day).toMatchObject({ date: "2026-09-24", runs: { silver: 1, gold: 1, copper: 1 } });
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
