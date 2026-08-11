// ---------------------------------------------------------------------------
// Thin-client data layer. ALL market data is fetched + computed server-side by
// the GitHub Action (scripts/build-data.mjs) and committed as a single JSON
// file. The browser just reads it — no third-party CORS dependencies, no
// client-side history accumulation. We read the freshest copy from the raw
// GitHub URL (Access-Control-Allow-Origin: *), falling back to the bundled copy.
// ---------------------------------------------------------------------------

import type { LiveInputs, McxData, Snapshot } from "./types";
import { cacheGet, cacheSet } from "./cache";

const BASE = import.meta.env.BASE_URL ?? "/";

// Repo coordinates for the always-fresh raw data file. This MUST be the branch
// the data cron commits to (the repo's default branch) — the bundled copy under
// `${BASE}data/` is only as fresh as the last Pages deploy, whereas this updates
// every ~10 min. Kept as named parts so re-pointing is a one-line change and
// never again a magic string buried mid-URL (AUDIT finding B5).
const DATA_REPO = "JazzeshWolf/SLIVER-SCREENER";
const DATA_BRANCH = "main";
const RAW_URL = `https://raw.githubusercontent.com/${DATA_REPO}/${DATA_BRANCH}/public/data/latest.json`;

async function timed<T>(p: Promise<T>, ms = 9000): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await timed(fetch(url, { headers: { accept: "application/json" }, cache: "no-store" }));
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Normalize a parsed latest.json into our Snapshot shape (defensive). */
function toSnapshot(j: McxData & { live?: LiveInputs }): Snapshot {
  const live: LiveInputs = j.live ?? {
    xagUsd: null,
    xauUsd: null,
    usdInr: null,
    dxy: null,
    real10y: null,
    breakeven10y: null,
    xagHistory: [],
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
export async function fetchLiveSpot(): Promise<
  { xagUsd: number | null; xauUsd: number | null; usdInr: number | null } | null
> {
  const j = async (url: string) => (await timed(fetch(url, { cache: "no-store" }), 6000)).json();
  const [xag, xau, inr] = await Promise.allSettled([
    j("https://api.gold-api.com/price/XAG"),
    j("https://api.gold-api.com/price/XAU"),
    j("https://api.frankfurter.app/latest?from=USD&to=INR"),
  ]);
  const price = (r: PromiseSettledResult<any>) =>
    r.status === "fulfilled" && typeof r.value?.price === "number" && r.value.price > 0 ? r.value.price : null;
  const xagUsd = price(xag);
  const xauUsd = price(xau);
  const usdInr =
    inr.status === "fulfilled" && typeof inr.value?.rates?.INR === "number" ? inr.value.rates.INR : null;
  if (xagUsd == null && xauUsd == null && usdInr == null) return null; // everything blocked
  return { xagUsd, xauUsd, usdInr };
}

/**
 * Load the snapshot: raw GitHub URL first (always fresh), then the bundled copy
 * shipped with the site, then the last cached snapshot. Never throws.
 */
export async function fetchSnapshot(): Promise<Snapshot | null> {
  try {
    const j = await getJson<McxData & { live?: LiveInputs }>(`${RAW_URL}?ts=${Date.now()}`);
    const snap = toSnapshot(j);
    cacheSet("snapshot", snap);
    return snap;
  } catch {
    // Fall back to the copy bundled into the deployed site.
  }
  try {
    const j = await getJson<McxData & { live?: LiveInputs }>(`${BASE}data/latest.json?ts=${Date.now()}`);
    const snap = toSnapshot(j);
    cacheSet("snapshot", snap);
    return snap;
  } catch {
    return cacheGet<Snapshot>("snapshot")?.value ?? null;
  }
}
