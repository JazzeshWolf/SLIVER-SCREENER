import type { LiveInputs } from "../lib/types";
import { correlation, tail } from "../lib/stats";
import { Card, SectionTitle, Pill, fmt } from "./ui";
import { Sparkline } from "./Sparkline";

export function CorrelationPanel({ live, gsr }: { live: LiveInputs; gsr: number | null }) {
  // Build GSR series from aligned histories.
  const n = Math.min(live.xagHistory.length, live.xauHistory.length);
  const gsrSeries = [];
  for (let i = 0; i < n; i++) {
    const ag = live.xagHistory[live.xagHistory.length - n + i]?.v;
    const au = live.xauHistory[live.xauHistory.length - n + i]?.v;
    if (ag && au && ag > 0) gsrSeries.push({ t: `i${i}`, v: au / ag });
  }
  const gsrValues = gsrSeries.map((p) => p.v);
  const gsrMean = gsrValues.length ? gsrValues.reduce((a, b) => a + b, 0) / gsrValues.length : null;
  const gsrLo = gsrValues.length ? Math.min(...gsrValues) : 0;
  const gsrHi = gsrValues.length ? Math.max(...gsrValues) : 1;

  const corr20 = correlation(tail(live.xagHistory, 20), tail(live.xauHistory, 20));
  const corr60 = correlation(tail(live.xagHistory, 60), tail(live.xauHistory, 60));

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle>Gold-silver ratio</SectionTitle>
        <div className="flex items-end justify-between">
          <div className="text-3xl font-bold tnum">{fmt(gsr, 1)}</div>
          <Sparkline data={gsrSeries} width={160} height={48} band={{ lo: gsrLo, hi: gsrHi, mean: gsrMean ?? undefined }} />
        </div>
        <p className="text-xs text-white/40 mt-1">
          {gsrMean !== null && gsr !== null
            ? gsr > gsrMean
              ? "Above mean → silver historically cheap vs gold (mild mean-revert long bias)."
              : "Below mean → silver relatively stretched vs gold."
            : "Building history… ratio band appears as data accrues."}
        </p>
      </Card>

      <Card>
        <SectionTitle>Silver–gold rolling correlation</SectionTitle>
        <div className="flex gap-4">
          <CorrChip label="20-day" v={corr20} />
          <CorrChip label="60-day" v={corr60} />
        </div>
        <p className="text-xs text-white/40 mt-2">
          High correlation = silver trades on the monetary story (follow gold/DXY/yields). A breakdown
          means the industrial story is driving it — weight silver's own momentum more.
        </p>
      </Card>
    </div>
  );
}

function CorrChip({ label, v }: { label: string; v: number | null }) {
  const tone = v === null ? "neutral" : v > 0.6 ? "bull" : v < 0.2 ? "warn" : "neutral";
  return (
    <div>
      <div className="text-[10px] uppercase text-white/40">{label}</div>
      <div className="mt-1">
        <Pill tone={tone}>{v === null ? "n/a" : v.toFixed(2)}</Pill>
      </div>
    </div>
  );
}
