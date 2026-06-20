import type { NewsItem } from "../lib/types";
import { Card, SectionTitle, Pill, timeAgo } from "./ui";

function ImpactChip({ impact }: { impact: NewsItem["impact"] }) {
  if (impact === "up") return <Pill tone="bull">↑ silver</Pill>;
  if (impact === "down") return <Pill tone="bear">↓ silver</Pill>;
  return <Pill tone="warn">↕ mixed</Pill>;
}

export function NewsTab({ news }: { news: NewsItem[] }) {
  if (!news?.length) {
    return (
      <Card>
        <SectionTitle>Silver news</SectionTitle>
        <p className="text-sm text-white/40">No headlines yet — populates on the next data refresh.</p>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-white/35 px-1 leading-snug">
        Silver-relevant headlines, newest first — tap to read the full story at the source. Impact is
        auto-tagged from keywords (a quick lean, not gospel).
      </p>
      {news.map((n, i) => (
        <a key={n.url + i} href={n.url} target="_blank" rel="noopener noreferrer" className="block">
          <Card className="hover:bg-[#141a24] active:bg-[#141a24] transition-colors">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[11px] text-white/45 truncate">
                {n.source} · {timeAgo(n.publishedAt)}
              </span>
              <ImpactChip impact={n.impact} />
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
