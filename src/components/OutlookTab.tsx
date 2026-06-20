import type { Outlook, OutlookDriver, Stance } from "../lib/outlook";
import { Card, SectionTitle, Pill, Implication } from "./ui";

function StanceChip({ stance }: { stance: Stance }) {
  if (stance === "up") return <Pill tone="bull">↑ bullish</Pill>;
  if (stance === "down") return <Pill tone="bear">↓ bearish</Pill>;
  return <Pill tone="neutral">→ neutral</Pill>;
}

function BiasBar({ value }: { value: number }) {
  const pct = Math.abs(value) / 10 * 50;
  const color = value >= 2 ? "bg-emerald-400" : value <= -2 ? "bg-rose-400" : "bg-sky-400";
  return (
    <div className="relative h-2 rounded-full bg-white/10 mt-2">
      <div className="absolute left-1/2 top-0 h-full w-px bg-white/30" />
      <div className={`absolute top-0 h-full rounded-full ${color}`}
        style={{ left: value >= 0 ? "50%" : `${50 - pct}%`, width: `${pct}%` }} />
    </div>
  );
}

function DriverRow({ d }: { d: OutlookDriver }) {
  return (
    <div className="py-2 border-b border-white/5 last:border-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-white/85 font-medium">{d.category}</span>
        <span className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-white/40 tnum">{d.weight}%</span>
          <StanceChip stance={d.stance} />
        </span>
      </div>
      <div className="mt-1 flex items-start gap-1.5">
        {!d.live && <span className="text-[9px] uppercase tracking-wide text-white/30 border border-white/10 rounded px-1 mt-0.5 shrink-0">struct</span>}
        <p className="text-[11px] text-white/55 leading-snug">{d.note}</p>
      </div>
    </div>
  );
}

export function OutlookTab({ outlook }: { outlook: Outlook }) {
  return (
    <div className="space-y-3">
      <Card className="bg-gradient-to-b from-[#141a24] to-[#11161f]">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/40">30-Day Silver Outlook</div>
            <div className="text-xl font-bold mt-0.5">{outlook.leanLabel}</div>
          </div>
          <Pill tone={outlook.leanTone}>
            {outlook.horizonScore >= 0 ? "+" : ""}{outlook.horizonScore.toFixed(1)} · {(outlook.confidence * 100).toFixed(0)}%
          </Pill>
        </div>
        <BiasBar value={outlook.netBias} />
        <div className="flex justify-between text-[9px] text-white/30 mt-1">
          <span>bearish</span><span>weighted driver bias</span><span>bullish</span>
        </div>
        <p className="text-xs text-white/70 mt-3 leading-relaxed">{outlook.summary}</p>
      </Card>

      <Card>
        <SectionTitle>Weighted drivers</SectionTitle>
        <div>
          {outlook.drivers.map((d) => <DriverRow key={d.category} d={d} />)}
        </div>
        <p className="text-[10px] text-white/30 mt-2">
          Weighting follows the backtest: timely macro/flow surprises heaviest, structural outlooks
          moderate, positioning as a contrarian override. "struct" = slow structural input.
        </p>
      </Card>

      <Card>
        <SectionTitle>Seller playbook</SectionTitle>
        <Implication tone={outlook.leanTone} label="How to express it">{outlook.playbook}</Implication>
        <Implication tone="neutral" label="Volatility">{outlook.volNote}</Implication>
        <Implication tone="warn" label="Positioning">{outlook.positioning}</Implication>
      </Card>

      <p className="text-[10px] text-white/30 px-1 leading-relaxed">
        Method: an ensemble of weighted signals beat any single one in a 5-month report-vs-price
        backtest (~70% vs ~60% hit-rate; ~0.35 correlation with 1-week returns). This is a
        probabilistic lean, not a forecast — size and risk accordingly.
      </p>
    </div>
  );
}
