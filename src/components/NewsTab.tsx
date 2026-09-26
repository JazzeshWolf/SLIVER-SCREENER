import type { NewsItem } from "../lib/types";
import type { MetalConfig } from "../lib/metals.mjs";
import { Card, SectionTitle, Pill, timeAgo } from "./ui";

function ImpactChip({ impact, name }: { impact: NewsItem["impact"]; name: string }) {
  if (impact === "up") return <Pill tone="bull">↑ {name}</Pill>;
  if (impact === "down") return <Pill tone="bear">↓ {name}</Pill>;
  return <Pill tone="warn">↕ mixed</Pill>;
}

export function NewsTab({ news, metal }: { news: NewsItem[]; metal: MetalConfig }) {
  const name = metal.label.toLowerCase();
  if (!news?.length) {
    return (
      <Card>
        <SectionTitle>{metal.label} news</SectionTitle>
        <p className="text-sm text-white/40">No headlines yet — populates on the next data refresh.</p>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-white/35 px-1 leading-snug">
        {metal.label} headlines plus the stories that drive it (tagged “macro”) — trusted outlets
        first (✓), nothing older than ~2½ weeks. Tap to read at the source. Impact is
        keyword-tagged (a lean, not gospel).
      </p>
      {news.map((n, i) => (
        <a key={n.url + i} href={n.url} target="_blank" rel="noopener noreferrer" className="block">
          <Card className="hover:bg-[#141a24] active:bg-[#141a24] transition-colors">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[11px] text-white/45 truncate">
                {n.trusted && <span className="text-emerald-300/90 mr-1" title="trusted source">✓</span>}
                {n.source} · {timeAgo(n.publishedAt)}
                {n.indirect && (
                  <span className="ml-1.5 rounded border border-sky-400/30 bg-sky-500/10 px-1 py-px text-[9px] uppercase tracking-wide text-sky-300/80">
                    macro
                  </span>
                )}
              </span>
              <ImpactChip impact={n.impact} name={name} />
            </div>
            <div className="text-sm font-medium text-white/90 leading-snug">{n.title}</div>
            {n.snippet && (
              <p className="text-[11px] text-white/50 mt-1 leading-snug line-clamp-2">{n.snippet}</p>
            )}
            <div className="text-[10px] text-sky-300/70 mt-1.5">Read at {n.source} →</div>
          </Card>
        </a>
      ))}
    </div>
  );
}
