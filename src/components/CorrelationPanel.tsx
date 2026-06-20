import type { LiveInputs } from "../lib/types";
import { correlation, tail } from "../lib/stats";
import { Card, SectionTitle, Pill, Implication, fmt } from "./ui";
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
  const gsrPast = gsrValues.length > 11 ? gsrValues[gsrValues.length - 11] : null;
  const gsrTrendUp = gsr != null && gsrPast != null ? gsr > gsrPast : null;

  const corr20 = correlation(tail(live.xagHistory, 20), tail(live.xauHistory, 20));
  const corr60 = correlation(tail(live.xagHistory, 60), tail(live.xauHistory, 60));

  // --- GSR implication ---
  let gsrTone: "bull" | "bear" | "neutral" | "warn" = "neutral";
  let gsrText = "Building history — implication appears as data accrues.";
  if (gsr != null && gsrMean != null) {
    const dev = (gsr - gsrMean) / gsrMean;
    const trendTxt =
      gsrTrendUp === null
        ? ""
        : gsrTrendUp
          ? " The ratio is rising lately (gold outpacing silver)."
          : " The ratio is falling lately (silver outperforming gold).";
    if (dev < -0.02) {
      gsrTone = "warn";
      gsrText = `At ${fmt(gsr, 1)}, silver is ~${Math.abs(dev * 100).toFixed(0)}% richer than its recent norm vs gold — it's been the stronger of the two. Good momentum, but valuation is stretched, so further silver out-performance gets harder; a snap-back would favour gold.${trendTxt}`;
    } else if (dev > 0.02) {
      gsrTone = "bull";
      gsrText = `At ${fmt(gsr, 1)}, silver is ~${(dev * 100).toFixed(0)}% cheaper than its recent norm vs gold — historically a setup where silver mean-reverts UP to catch gold. Mild relative tailwind for silver.${trendTxt}`;
    } else {
      gsrTone = "neutral";
      gsrText = `At ${fmt(gsr, 1)}, silver and gold are fairly priced against each other — no strong relative edge either way right now.${trendTxt}`;
    }
  }

  // --- Correlation implication ---
  let corrTone: "bull" | "bear" | "neutral" | "warn" = "neutral";
  let corrText = "Not enough history yet.";
  if (corr20 != null) {
    const decoupled = corr60 != null && corr60 < 0.3;
    if (corr20 > 0.6) {
      corrTone = "neutral";
      corrText = `Silver is moving in lockstep with gold (20-day ${corr20.toFixed(2)}). Trade the macro — gold, the dollar and real yields are steering silver, so lean your direction read on those.`;
      if (decoupled) corrText += ` But the 60-day (${corr60!.toFixed(2)}) is weak, so they were on separate paths recently — don't treat gold as the only driver.`;
    } else if (corr20 < 0.3) {
      corrTone = "warn";
      corrText = `Silver has decoupled from gold short-term (20-day ${corr20.toFixed(2)}) — it's trading on its own story (industrial demand / positioning). Weight silver's own momentum and MCX flow over gold here.`;
    } else {
      corrText = `Silver partly tracks gold (20-day ${corr20.toFixed(2)}) — a mix of the monetary and its own story. Watch both.`;
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle>Gold-silver ratio (GSR)</SectionTitle>
        <div className="flex items-end justify-between">
          <div>
            <div className="text-3xl font-bold tnum">{fmt(gsr, 1)}</div>
            <div className="text-[10px] text-white/40 mt-0.5">
              avg {gsrMean ? fmt(gsrMean, 1) : "—"} · oz silver per oz gold
            </div>
          </div>
          <Sparkline data={gsrSeries} width={150} height={46} band={{ lo: gsrLo, hi: gsrHi, mean: gsrMean ?? undefined }} />
        </div>
        <Implication tone={gsrTone}>{gsrText}</Implication>
      </Card>

      <Card>
        <SectionTitle>Silver–gold rolling correlation</SectionTitle>
        <div className="flex gap-4">
          <CorrChip label="20-day" v={corr20} />
          <CorrChip label="60-day" v={corr60} />
        </div>
        <Implication tone={corrTone}>{corrText}</Implication>
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
