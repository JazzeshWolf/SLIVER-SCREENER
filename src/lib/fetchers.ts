// ---------------------------------------------------------------------------
// Thin-client data layer. ALL market data is fetched + computed server-side by
// the GitHub Action (scripts/build-data.mjs) and committed as a single JSON
// file. The browser just reads it — no third-party CORS dependencies, no
// client-side history accumulation. We read the freshest copy from the raw
// GitHub URL (Access-Control-Allow-Origin: *), falling back to the bundled copy.
// ---------------------------------------------------------------------------

import type { LiveInputs, McxData, MetalSummary, Snapshot } from "./types";
import { cacheGet, cacheSet } from "./cache";
import { DEFAULT_METAL, metalFor } from "./metals.mjs";

const BASE = import.meta.env.BASE_URL ?? "/";

// Repo coordinates for the always-fresh raw data file. This MUST be the branch
// the data cron commits to (the repo's default branch) — the bundled copy under
// `${BASE}data/` is only as fresh as the last Pages deploy, whereas this updates
// every ~10 min. Kept as named parts so re-pointing is a one-line change and
// never again a magic string buried mid-URL (AUDIT finding B5).
const DATA_REPO = "JazzeshWolf/SLIVER-SCREENER";
const DATA_BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${DATA_REPO}/${DATA_BRANCH}/public/data`;

async function timed<T>(p: Promise<T>, ms = 9000): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

async function getJson<T>(url: string, ms?: number): Promise<T> {
  const res = await timed(
    fetch(url, { headers: { accept: "application/json" }, cache: "no-store" }),
    ms,
  );
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

// The raw GitHub copy is the FRESH one (updated every ~10 min); the bundled
// copy is only as fresh as the last Pages deploy. So we want raw when we can
// get it — but we must not make the user wait out a full timeout to find out
// it is blocked. Fetch both at once and prefer raw if it answers.
const REMOTE_MS = 6000;
// How long we'll wait for the fresh copy before falling back to the bundled
// one. A healthy raw.githubusercontent fetch answers well inside this; a
// blocked one hangs until its timeout, and making the user stare at "Loading"
// for six seconds to discover that is worse than showing slightly older data
// (which the 5-minute refresh and the live-spot overlay both correct anyway).
const REMOTE_GRACE_MS = 2500;

async function preferRemote<T>(remoteUrl: string, localUrl: string): Promise<T> {
  const remote = getJson<T>(remoteUrl, REMOTE_MS);
  remote.catch(() => {}); // never let a late rejection escape unhandled

  const raced = await Promise.race([
    remote.then((v) => ({ hit: true as const, v })).catch(() => ({ hit: false as const })),
    new Promise<{ hit: false }>((r) => setTimeout(() => r({ hit: false }), REMOTE_GRACE_MS)),
  ]);
  if (raced.hit) return raced.v;

  try {
    return await getJson<T>(localUrl);
  } catch {
    // No bundled copy either (e.g. gold.json on a site deployed before the
    // multi-metal split) — give the remote its full timeout after all.
    return await remote;
  }
}

/**
 * Accept the pre-metals field names as well as the current ones.
 *
 * The snapshot on disk is written by the cron, so between deploying this client
 * and the next successful builder run the live file still says `silverFut` /
 * `xagUsd` / `xagHistory`. Without this the app would render blank against its
 * own data. Also covers a stale localStorage snapshot from an older visit.
 */
function migrateLegacyNames(j: any): any {
  if (!j || typeof j !== "object") return j;
  const mcx = j.mcx && typeof j.mcx === "object" ? { ...j.mcx } : j.mcx;
  if (mcx && mcx.fut == null && mcx.silverFut != null) mcx.fut = mcx.silverFut;

  const live = j.live && typeof j.live === "object" ? { ...j.live } : j.live;
  if (live) {
    if (live.metalUsd == null && live.xagUsd != null) live.metalUsd = live.xagUsd;
    if (!live.metalHistory?.length && live.xagHistory?.length) live.metalHistory = live.xagHistory;
  }

  const expiries = Array.isArray(j.expiries)
    ? j.expiries.map((e: any) => (e && e.fut == null && e.silverFut != null ? { ...e, fut: e.silverFut } : e))
    : j.expiries;

  return { ...j, mcx, live, expiries };
}

/** Normalize a parsed latest.json into our Snapshot shape (defensive). */
function toSnapshot(raw: McxData & { live?: LiveInputs }): Snapshot {
  const j = migrateLegacyNames(raw) as McxData & { live?: LiveInputs };
  const live: LiveInputs = j.live ?? {
    metalUsd: null,
    xauUsd: null,
    usdInr: null,
    dxy: null,
    real10y: null,
    breakeven10y: null,
    metalHistory: [],
    xauHistory: [],
    dxyHistory: [],
    real10yHistory: [],
    usdInrHistory: [],
    asOf: j.asOf,
    partial: true,
  };
  const { live: _omit, ...mcx } = j;
  return { live, mcx: mcx as McxData };
}

/**
 * Live international spot, fetched straight from the browser (these APIs are
 * CORS-enabled). Lets the ⟳ button actually update prices even when the
 * server-built snapshot is stale. Returns null on any failure so the caller
 * falls back to the server values — never throws, never blocks.
 */
export async function fetchLiveSpot(
  metalId: string = DEFAULT_METAL,
): Promise<{ metalUsd: number | null; xauUsd: number | null; usdInr: number | null } | null> {
  const metal = metalFor(metalId);
  const j = async (url: string) => (await timed(fetch(url, { cache: "no-store" }), 6000)).json();
  const price = (r: PromiseSettledResult<any>) =>
    r.status === "fulfilled" && typeof r.value?.price === "number" && r.value.price > 0 ? r.value.price : null;

  // Gold and the rupee are always fetched: gold doubles as the cross-metal
  // reference (GSR for silver, copper/gold for copper) and USD-INR drives the
  // parity for all three.
  //
  // COPPER HAS NO FREE CORS SPOT API. gold-api.com serves XAU/XAG only, so
  // `intlFeeds.goldApi` is null and copper simply has no browser-side live
  // overlay — it refreshes on the server's ~10-minute cadence. That is a real
  // limitation, and the UI says so rather than implying a live tick.
  const own = metal.intlFeeds.goldApi;
  const [ownRes, xau, inr] = await Promise.allSettled([
    own && own !== "XAU" ? j(`https://api.gold-api.com/price/${own}`) : Promise.reject(new Error("n/a")),
    j("https://api.gold-api.com/price/XAU"),
    j("https://api.frankfurter.app/latest?from=USD&to=INR"),
  ]);

  const xauUsd = price(xau);
  const metalUsd = own === "XAU" ? xauUsd : price(ownRes);
  const usdInr =
    inr.status === "fulfilled" && typeof inr.value?.rates?.INR === "number" ? inr.value.rates.INR : null;
  if (metalUsd == null && xauUsd == null && usdInr == null) return null; // everything blocked
  return { metalUsd, xauUsd, usdInr };
}

/** True when this metal has a browser-callable live spot feed at all. */
export function hasLiveSpot(metalId: string): boolean {
  return metalFor(metalId).intlFeeds.goldApi != null;
}

/**
 * Candidate filenames for a metal, best first. Silver falls back to the
 * pre-split `latest.json` so the app still works against a data branch that
 * has not run the multi-metal builder yet.
 */
function filesFor(metalId: string): string[] {
  const id = metalFor(metalId).id;
  return id === DEFAULT_METAL ? [`${id}.json`, "latest.json"] : [`${id}.json`];
}

/**
 * Load one metal's snapshot: raw GitHub URL first (always fresh), then the copy
 * bundled into the deployed site, then the last cached snapshot for that metal.
 * Never throws.
 */
export async function fetchSnapshot(metalId: string = DEFAULT_METAL): Promise<Snapshot | null> {
  const id = metalFor(metalId).id;
  const cacheKey = `snapshot:${id}`;
  for (const file of filesFor(id)) {
    try {
      const ts = Date.now();
      const j = await preferRemote<McxData & { live?: LiveInputs }>(
        `${RAW_BASE}/${file}?ts=${ts}`,
        `${BASE}data/${file}?ts=${ts}`,
      );
      const snap = toSnapshot(j);
      cacheSet(cacheKey, snap);
      return snap;
    } catch {
      /* try the next filename */
    }
  }
  return cacheGet<Snapshot>(cacheKey)?.value ?? null;
}

/**
 * The picker's summary cards. Falls back to a synthesized silver-only list so
 * the app still opens against a data branch predating index.json.
 */
export async function fetchMetalIndex(): Promise<MetalSummary[] | null> {
  try {
    const ts = Date.now();
    const j = await preferRemote<{ metals?: MetalSummary[] }>(
      `${RAW_BASE}/index.json?ts=${ts}`,
      `${BASE}data/index.json?ts=${ts}`,
    );
    if (Array.isArray(j?.metals) && j.metals.length) {
      cacheSet("metalIndex", j.metals);
      return j.metals;
    }
  } catch {
    /* fall through to cache */
  }
  return cacheGet<MetalSummary[]>("metalIndex")?.value ?? null;
}
