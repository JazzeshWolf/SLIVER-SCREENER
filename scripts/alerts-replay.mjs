// ---------------------------------------------------------------------------
// Replay archived snapshots through the alert engine, printing (never sending)
// the Telegram messages each data commit would have produced.
//
// The data cron commits every snapshot to `main` with ordinary commits, so the
// git history IS the archive. Each commit is replayed through the same run()
// that production uses — freshness, arming, diff, heartbeat — with the clock
// set to the commit time and a throwaway state dir.
//
//   npm run alerts:replay -- [--since 2026-09-01] [--ref origin/main]
//                            [--threshold 70] [--quiet]
//
// Needs real history: a shallow clone replays nothing
// (`git fetch --depth=5000 origin main` first). --quiet prints only the tally.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METAL_IDS } from "../src/lib/metals.mjs";
import { DEFAULT_THRESHOLD, istDate, istTime, run } from "./alerts.mjs";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const ref = arg("ref", "origin/main");
const since = arg("since", "2026-08-11"); // per-metal files start here
const threshold = Number(arg("threshold", DEFAULT_THRESHOLD));
const quiet = process.argv.includes("--quiet");

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const paths = METAL_IDS.map((id) => `public/data/${id}.json`);
const commits = git("log", ref, "--reverse", `--since=${since}`, "--format=%H %cI", "--", ...paths)
  .trim().split("\n").filter(Boolean).map((l) => l.split(" "));

const root = mkdtempSync(join(tmpdir(), "alerts-replay-"));
const dataDir = join(root, "data");
const stateDir = join(root, "state");
execFileSync("mkdir", ["-p", dataDir]);

let messages = 0;
const kinds = { NEW: 0, MOVED: 0, DROPPED: 0, LEFT: 0 };
const perDay = new Map();
try {
  for (const [sha, at] of commits) {
    for (const id of METAL_IDS) {
      try {
        writeFileSync(join(dataDir, `${id}.json`), git("show", `${sha}:public/data/${id}.json`));
      } catch {
        rmSync(join(dataDir, `${id}.json`), { force: true });
      }
    }
    // The alert step runs right after the data commit.
    const now = new Date(Date.parse(at) + 30_000);
    await run({
      dataDir, stateDir, now, threshold,
      log: () => {},
      send: (text) => {
        messages++;
        for (const l of text.split("\n")) {
          if (l.startsWith("🔔 NEW")) kinds.NEW++;
          else if (l.startsWith("⬆️") || l.startsWith("⬇️")) kinds.MOVED++;
          else if (l.startsWith("🔻")) kinds.DROPPED++;
          else if (l.startsWith("🚪")) kinds.LEFT++;
        }
        const d = istDate(now);
        perDay.set(d, (perDay.get(d) ?? 0) + 1);
        if (!quiet) console.log(`===== ${istDate(now)} ${istTime(now)} IST (commit ${sha.slice(0, 7)}) =====\n${text}\n`);
      },
    });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const days = [...perDay.values()];
console.log(
  `Replayed ${commits.length} data commits since ${since} at CONV ≥ ${threshold}: ${messages} messages ` +
    `(${JSON.stringify(kinds)}), on ${days.length} days, max ${Math.max(0, ...days)} in a day.`,
);
