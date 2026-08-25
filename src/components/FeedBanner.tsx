import type { McxData } from "../lib/types";
import { timeAgo } from "./ui";

/**
 * Loud warning when the live MCX feed is down because the Upstox token is
 * dead (401/403) or missing — so you never have to read CI logs to notice.
 * Silent for "ok" and "degraded" (normal off-hours empty chain), to avoid
 * crying wolf every night and weekend.
 */
export function FeedBanner({ mcx }: { mcx: McxData }) {
  // Nothing tradeable left in the snapshot: every listed option expiry has
  // passed, so the chain, IV and DTE on screen belong to a dead contract. This
  // outranks the token warning — it is why the data stopped moving.
  if (mcx.contractsExpired) {
    return (
      <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5">
        <div className="flex items-center gap-2 text-sm font-semibold text-rose-200">
          <span aria-hidden>⚠</span>
          <span>Contract expired — data has not refreshed</span>
        </div>
        <p className="mt-1 text-[12px] leading-snug text-rose-100/80">
          Every option expiry in this snapshot has already passed. Last server run{" "}
          {timeAgo(mcx.asOf)} — the chain, IV, GEX and expected move below describe a contract that
          no longer trades. Nothing here is sellable until the feed rolls to the next expiry.
        </p>
      </div>
    );
  }

  const feed = mcx.feed;
  if (!feed || (feed.upstox !== "auth_failed" && feed.upstox !== "no_token")) return null;

  const noToken = feed.upstox === "no_token";
  const since = feed.lastLiveAt ? timeAgo(feed.lastLiveAt) : null;
  return (
    <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5">
      <div className="flex items-center gap-2 text-sm font-semibold text-rose-200">
        <span aria-hidden>⚠</span>
        <span>{noToken ? "No Upstox token configured" : "Upstox token not working (401)"}</span>
      </div>
      <p className="mt-1 text-[12px] leading-snug text-rose-100/80">
        Live MCX options feed is down — no real option chain, implied vol, or GEX.{" "}
        {since ? `Showing last-good from ${since}; ` : "Running on estimates; "}
        IV/GEX are estimated until it's back. Refresh{" "}
        <code className="text-rose-200">UPSTOX_ACCESS_TOKEN</code> in the repo secrets to restore live data.
      </p>
    </div>
  );
}
