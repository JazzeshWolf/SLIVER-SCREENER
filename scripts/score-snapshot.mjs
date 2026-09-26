// ---------------------------------------------------------------------------
// Score a set of snapshot files the way the Sell tab would, and write the result
// as one JSON document. This is the contract the EOD archive
// (JazzeshWolf/sliver-screener-eod-archive) calls every morning: the snapshots
// on `main` carry prices but not CONV, which the browser computes, so the
// archive asks THIS repo's code to compute it rather than keeping a copy of the
// scorer that would drift.
//
//   npx vite-node scripts/score-snapshot.mjs -- --data <dir> --out <file>
//                                               [--prev <yesterday's candidates.json>]
//
// <dir> holds silver.json / gold.json / copper.json (any subset). --prev lends
// yesterday's regimes as the hysteresis memory the browser would have had.
//
// Keep the output backwards compatible: bump SCHEMA and say what changed if a
// field has to change meaning. The archive stores these files forever.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { METALS, METAL_IDS } from "../src/lib/metals.mjs";

export const SCHEMA = 1;

const round = (v, d = 4) => (typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(d)) : v ?? null);

/** One metal's snapshot → every expiry the Sell tab offers, every OTM leg it scored. */
export function scoreMetal(sellView, id, snap, prevRegime) {
  const { live, ...mcx } = snap;
  // The clock is the snapshot's own capture time, never the wall clock, so a
  // re-score of an old day reproduces the gates it had then.
  const now = new Date(snap.feed?.lastLiveAt ?? snap.asOf);
  const view = sellView(live, mcx, prevRegime ?? undefined, now);
  const byExpiry = new Map((mcx.expiries ?? []).map((b) => [b.optionExpiry, b]));
  return {
    symbol: mcx.mcx?.symbol ?? METALS[id].feedSymbol,
    asOf: snap.asOf,
    lastLiveAt: snap.feed?.lastLiveAt ?? null,
    scoredAt: now.toISOString(),
    prevRegime: prevRegime ?? null,
    regime: view.regime,
    score: view.score,
    expiries: view.expiries.map((e) => {
      const shown = new Set([...e.shown.PE, ...e.shown.CE].map((c) => `${c.strike}|${c.type}`));
      return {
        optionExpiry: e.optionExpiry,
        futExpiry: byExpiry.get(e.optionExpiry)?.expiry ?? mcx.mcx?.expiry ?? null,
        optionDte: e.optionDte,
        fut: e.fut,
        gates: {
          blocked: e.gates.blocked,
          band: e.gates.band,
          score: round(e.gates.score, 2),
          vrp: round(e.gates.vrp.vrp, 2),
          vrpBlocked: e.gates.vrp.blocked,
          vrpProxy: e.gates.vrp.proxy,
          eventVeto: e.gates.events.vetoed,
        },
        screen: {
          forecastVol: round(e.screen.forecastVol),
          drift: round(e.screen.drift),
          confidence: round(e.screen.confidence, 3),
          lotUnits: e.screen.lotUnits,
          smileFitted: e.screen.smileFitted,
          tooThin: !!e.screen.tooThin,
          chainOi: e.screen.chainOi ?? null,
        },
        candidates: e.screen.candidates.map((c) => ({
          strike: c.strike,
          type: c.type,
          conv: c.conv,
          ok: c.ok,
          reasons: c.reasons,
          displayed: shown.has(`${c.strike}|${c.type}`),
          premium: c.premium,
          credit: round(c.credit, 2),
          iv: round(c.iv),
          ivQuoted: round(c.ivQuoted),
          ivFitted: round(c.ivFitted),
          delta: round(c.delta),
          cushion: round(c.cushion, 3),
          pOtm: round(c.pOtm),
          touch: round(c.touch),
          fair: round(c.fair, 2),
          edge: round(c.edge, 2),
          edgePct: round(c.edgePct, 3),
          romAnnual: round(c.romAnnual, 2),
          margin: round(c.margin, 2),
          marginPerLot: round(c.marginPerLot, 0),
          cvar: round(c.cvar, 2),
          tailPct: round(c.tailPct, 2),
          oi: c.oi,
          oiChg: c.oiChg,
          thin: c.thin,
          withRegime: c.withRegime,
          sub: Object.fromEntries(Object.entries(c.sub).map(([k, v]) => [k, round(v)])),
        })),
      };
    }),
  };
}

/** Score every metal file found in `snaps` ({ silver: json, ... }). */
export function scoreAll(sellView, snaps, prev = null) {
  const metals = {};
  for (const id of METAL_IDS) {
    if (!snaps[id]) continue;
    metals[id] = scoreMetal(sellView, id, snaps[id], prev?.metals?.[id]?.regime?.regime ?? null);
  }
  return { schema: SCHEMA, metals };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
}

function scorerSha() {
  if (process.env.SCORER_SHA) return process.env.SCORER_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export async function main() {
  const dir = arg("data");
  const out = arg("out");
  if (!dir || !out) throw new Error("usage: score-snapshot.mjs --data <dir> --out <file> [--prev <file>]");
  const { sellView } = await import("../src/lib/sellView.ts");
  const snaps = {};
  for (const id of METAL_IDS) {
    const p = resolve(dir, `${id}.json`);
    if (existsSync(p)) snaps[id] = JSON.parse(readFileSync(p, "utf8"));
  }
  const prevPath = arg("prev");
  const prev = prevPath && existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, "utf8")) : null;
  const doc = { ...scoreAll(sellView, snaps, prev), scorer: { repo: "JazzeshWolf/SLIVER-SCREENER", sha: scorerSha() } };
  writeFileSync(out, JSON.stringify(doc) + "\n");
  const n = Object.values(doc.metals).reduce((a, m) => a + m.expiries.reduce((b, e) => b + e.candidates.length, 0), 0);
  console.log(`scored ${Object.keys(doc.metals).join(", ")}: ${n} strikes → ${out}`);
}
