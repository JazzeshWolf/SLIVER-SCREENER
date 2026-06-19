import type { MarketEvent } from "../lib/types";
import { Card, SectionTitle, Pill } from "./ui";

const KIND_LABEL: Record<MarketEvent["kind"], string> = {
  fomc: "Fed FOMC",
  us_cpi: "US CPI",
  us_jobs: "US Jobs",
  rbi: "RBI Policy",
  mcx_expiry: "MCX Expiry",
  other: "Event",
};

const KIND_ICON: Record<MarketEvent["kind"], string> = {
  fomc: "🏛️",
  us_cpi: "📊",
  us_jobs: "👷",
  rbi: "🇮🇳",
  mcx_expiry: "⏳",
  other: "📌",
};

export function EventRadar({ events }: { events: MarketEvent[] }) {
  const today = new Date();
  const upcoming = events
    .map((e) => ({ ...e, days: Math.ceil((new Date(e.date).getTime() - today.getTime()) / 86400000) }))
    .filter((e) => e.days >= 0)
    .sort((a, b) => a.days - b.days)
    .slice(0, 6);

  return (
    <Card>
      <SectionTitle>IV-crush / event radar</SectionTitle>
      {upcoming.length === 0 ? (
        <p className="text-sm text-white/40">No events scheduled in the feed.</p>
      ) : (
        <div className="space-y-1.5">
          {upcoming.map((e) => {
            const soon = e.days <= 3;
            return (
              <div key={e.date + e.name} className="flex items-center justify-between">
                <span className="text-sm text-white/80">
                  {KIND_ICON[e.kind]} {KIND_LABEL[e.kind]}
                  <span className="text-white/40 text-xs ml-1">{e.date}</span>
                </span>
                {soon ? (
                  <Pill tone="warn">
                    {e.days === 0 ? "today" : `in ${e.days}d`} · vol risk
                  </Pill>
                ) : (
                  <span className="text-xs text-white/40">in {e.days}d</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[10px] text-white/30 mt-2">
        Sell premium <em>before</em> these (IV inflated → crushes after). Avoid opening fresh shorts
        into one with little time left.
      </p>
    </Card>
  );
}
