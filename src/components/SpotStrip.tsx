import type { LiveInputs, McxData } from "../lib/types";
import { Card, arrow, fmt, fmtInt } from "./ui";

function Cell({
  label,
  value,
  sub,
  dir,
}: {
  label: string;
  value: string;
  sub?: string;
  dir?: number | null;
}) {
  const tone = dir == null ? "text-white" : dir > 0 ? "text-emerald-300" : dir < 0 ? "text-rose-300" : "text-white";
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-white/40">{label}</span>
      <span className={`text-sm font-semibold tnum ${tone}`}>
        {value} {dir != null && <span className="text-xs">{arrow(dir)}</span>}
      </span>
      {sub && <span className="text-[10px] text-white/30 tnum">{sub}</span>}
    </div>
  );
}

function dirOf(hist: { v: number }[]): number | null {
  if (hist.length < 2) return null;
  return hist[hist.length - 1].v - hist[hist.length - 2].v;
}

export function SpotStrip({ live, mcx }: { live: LiveInputs; mcx: McxData | null }) {
  const gsr = live.xauUsd && live.xagUsd ? live.xauUsd / live.xagUsd : null;
  return (
    <Card>
      <div className="grid grid-cols-3 gap-y-3 gap-x-2">
        <Cell label="Silver $/oz" value={fmt(live.xagUsd)} dir={dirOf(live.xagHistory)} />
        <Cell label="Gold $/oz" value={fmt(live.xauUsd, 0)} dir={dirOf(live.xauHistory)} />
        <Cell label="GSR" value={fmt(gsr, 1)} />
        <Cell label="DXY" value={fmt(live.dxy, 1)} dir={dirOf(live.dxyHistory)} />
        <Cell label="USD-INR" value={fmt(live.usdInr, 2)} dir={dirOf(live.usdInrHistory)} />
        <Cell label="Real 10y" value={live.real10y == null ? "—" : `${fmt(live.real10y)}%`} />
        <Cell
          label="MCX ₹/kg"
          value={fmtInt(mcx?.mcx.silverFut ?? null)}
          sub={mcx?.mcx.silverFut && mcx.mcx.prevClose ? `${arrow(mcx.mcx.silverFut - mcx.mcx.prevClose)} prev ${fmtInt(mcx.mcx.prevClose)}` : undefined}
        />
        <Cell label="MCX OI" value={fmtInt(mcx?.mcx.oi ?? null)} sub={mcx?.mcx.oiChg != null ? `${arrow(mcx.mcx.oiChg)} ${fmtInt(Math.abs(mcx.mcx.oiChg))}` : undefined} />
        <Cell label="ATM IV" value={mcx?.options.atmIv == null ? "—" : `${(mcx.options.atmIv * 100).toFixed(0)}%`} sub={mcx?.options.ivRank != null ? `rank ${mcx.options.ivRank.toFixed(0)}` : undefined} />
      </div>
      {(live.partial || mcx?.stale) && (
        <div className="mt-2 text-[10px] text-amber-300/70">
          {live.partial && "Some live feeds fell back to cache. "}
          {mcx?.stale && "MCX snapshot is stale."}
        </div>
      )}
    </Card>
  );
}
