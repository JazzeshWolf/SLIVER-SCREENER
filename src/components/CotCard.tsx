import type { McxData } from "../lib/types";
import { Card, SectionTitle, Pill, Implication, fmtInt } from "./ui";
import { Sparkline } from "./Sparkline";

export function CotCard({ mcx }: { mcx: McxData }) {
  const cot = mcx.cot;
  if (!cot) {
    return (
      <Card>
        <SectionTitle>Speculative positioning (CFTC CoT)</SectionTitle>
        <p className="text-sm text-white/40">Loading COMEX silver positioning…</p>
      </Card>
    );
  }
  const p = cot.percentile;
  const extreme = p >= 80 ? "crowded long" : p <= 20 ? "crowded short" : "mid-range";
  const tone: "bull" | "bear" | "neutral" = p >= 80 ? "bear" : p <= 20 ? "bull" : "neutral";
  const impl =
    p >= 80
      ? `Speculators are heavily net long (top ${100 - p}% of the last ~1.5yr). Crowded one-sided books are a classic contrarian warning — corrections often start here. For a seller: short calls carry tailwind-risk; sell puts only with cushion.`
      : p <= 20
        ? `Speculators are lightly long / net short (bottom ${p}%). Washed-out positioning is contrarian-bullish and squeeze fuel — bottoms often form here. For a seller: short puts are better supported; be cautious with short calls.`
        : `Speculator net positioning is mid-range — no crowding extreme. Positioning isn't flashing a contrarian signal either way right now.`;

  return (
    <Card>
      <SectionTitle>Speculative positioning (CFTC CoT)</SectionTitle>
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="text-2xl font-bold tnum">{fmtInt(cot.net)}</div>
          <div className="text-[10px] text-white/40 mt-0.5">{cot.source} net · {cot.asOf}</div>
        </div>
        <div className="text-right">
          <Pill tone={tone}>{p}th pctile · {extreme}</Pill>
          <div className="mt-1.5 flex justify-end">
            <Sparkline data={cot.history} width={150} height={40} />
          </div>
        </div>
      </div>
      <Implication tone={tone}>{impl}</Implication>
      <p className="text-[10px] text-white/30 mt-2">
        COMEX silver, weekly (Tue data, ~3-day lag). A contrarian / override signal — strongest at
        extremes, not a day-to-day timing tool.
      </p>
    </Card>
  );
}
