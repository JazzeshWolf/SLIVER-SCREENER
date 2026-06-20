import type { MarketEvent } from "../lib/types";
import { Card, SectionTitle, Pill } from "./ui";

const KIND_LABEL: Record<MarketEvent["kind"], string> = {
  fomc: "Fed FOMC", us_cpi: "US CPI", us_jobs: "US Jobs", rbi: "RBI Policy", mcx_expiry: "MCX Expiry", other: "Event",
};
const KIND_ICON: Record<MarketEvent["kind"], string> = {
  fomc: "🏛️", us_cpi: "📊", us_jobs: "👷", rbi: "🇮🇳", mcx_expiry: "⏳", other: "📌",
};

function ImpactChip({ impact }: { impact?: MarketEvent["impact"] }) {
  if (impact === "up") return <Pill tone="bull">↑ silver</Pill>;
  if (impact === "down") return <Pill tone="bear">↓ silver</Pill>;
  return <Pill tone="warn">↕ two-way</Pill>;
}

/** Weight as 1–3 filled bars. */
function WeightBars({ weight = 1 }: { weight?: number }) {
  return (
    <span className="inline-flex items-end gap-0.5 h-3" title={`impact weight ${weight}/3`}>
      {[1, 2, 3].map((i) => (
        <span
          key={i}
          className={`w-1 rounded-sm ${i <= weight ? "bg-amber-400" : "bg-white/15"}`}
          style={{ height: `${i * 4 + 2}px` }}
        />
      ))}
    </span>
  );
}

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
        <div className="space-y-2.5">
          {upcoming.map((e) => {
            const soon = e.days <= 3;
            return (
              <div key={e.date + e.name} className={`rounded-xl p-2.5 ${soon ? "bg-amber-500/10 ring-1 ring-amber-500/20" : "bg-white/5"}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/90 font-medium">
                    {KIND_ICON[e.kind]} {KIND_LABEL[e.kind]}
                    <span className="text-white/40 text-xs ml-1.5">{e.date}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <WeightBars weight={e.weight} />
                    <span className={`text-xs tnum ${soon ? "text-amber-300 font-semibold" : "text-white/50"}`}>
                      {e.days === 0 ? "today" : `${e.days}d`}
                    </span>
                  </span>
                </div>
                <div className="mt-1.5 flex items-start gap-2">
                  <ImpactChip impact={e.impact} />
                  {e.effect && <p className="text-[11px] text-white/55 leading-snug flex-1">{e.effect}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[10px] text-white/30 mt-2">
        Sell premium <em>before</em> these (IV inflated → crushes after). Avoid opening fresh shorts into
        a major (3-bar) event with little time left.
      </p>
    </Card>
  );
}
