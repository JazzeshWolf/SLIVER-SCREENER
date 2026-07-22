import { useState } from "preact/hooks";
import type { Horizon, HorizonScore } from "../lib/types";
import { Card, SectionTitle } from "./ui";

// Plain-English decode of each engine factor — what it measures and how it
// moves silver. Keyed to FACTOR_CONFIG.key in src/lib/scoring.ts.
const DECODE: Record<string, string> = {
  dxy: "Dollar direction (inverse). Silver is priced in USD, so a falling dollar lifts it and a rising dollar weighs on it. Measured as z-scored DXY momentum.",
  real10y: "Real 10-year yield (inverse). Higher real yields raise the opportunity cost of holding non-yielding silver → bearish; falling real yields → bullish.",
  silverMomo: "Silver's own price momentum over the window. Trend-following — recent strength leans bullish, weakness bearish.",
  goldMomo: "Gold momentum. Gold leads the precious-metals complex and silver usually follows, with a higher beta.",
  longTrend: "Price vs its ~200-day average — the long-trend gate. Above = structurally bullish, below = bearish. Slow; only counts on 1W/1M.",
  mcxPositioning: "MCX futures open interest vs price — are participants adding or cutting risk. Rising OI that confirms the price move adds conviction.",
  usdInr: "USD-INR. A weaker rupee lifts MCX (₹/kg) silver even when international silver is flat; a stronger rupee is a headwind.",
  gsr: "Gold-silver ratio, mean-reverting. A stretched ratio (silver cheap vs gold) is a contrarian-bullish tell for silver.",
  deficitBias: "Structural supply deficit — silver has run a multi-year physical deficit. A small, constant bullish prior; slow-moving, 1W/1M only.",
};

/** Signed diverging bar for a signal in [-1, +1]. */
function FactorBar({ s, present }: { s: number; present: boolean }) {
  const w = Math.min(Math.abs(s), 1) * 50; // up to 50% each side of centre
  const color = !present ? "bg-white/10" : s > 0.05 ? "bg-emerald-400/80" : s < -0.05 ? "bg-rose-400/80" : "bg-sky-400/60";
  return (
    <div className="relative h-1.5 rounded-full bg-white/[0.06] mt-1">
      <div className="absolute left-1/2 top-0 h-full w-px bg-white/20" />
      <div
        className={`absolute top-0 h-full rounded-full ${color}`}
        style={{ left: s >= 0 ? "50%" : `${50 - w}%`, width: `${w}%` }}
      />
    </div>
  );
}

export function FactorBreakdown({ decision, horizon }: { decision: HorizonScore; horizon: Horizon }) {
  const [open, setOpen] = useState<string | null>(null);
  // Show the factors that carry weight at this horizon (present or not), the
  // heaviest first — mirrors what actually drives the score.
  const rows = decision.factors
    .filter((f) => f.weight > 0 || f.present)
    .sort((a, b) => b.weight - a.weight);

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <SectionTitle>Why — factor breakdown</SectionTitle>
        <span className="text-[10px] uppercase tracking-wider text-white/30">{horizon} · tap a row</span>
      </div>

      <div className="space-y-2.5 mt-1">
        {rows.map((f) => (
          <div key={f.key}>
            <button
              onClick={() => setOpen((o) => (o === f.key ? null : f.key))}
              className="w-full text-left"
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`text-sm ${f.present ? "text-white/80" : "text-white/30"}`}>
                  <span className="text-white/30 mr-1">{open === f.key ? "▾" : "›"}</span>
                  {f.label}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-white/30 tnum">w {(f.weight * 100).toFixed(0)}%</span>
                  <span
                    className={`tnum text-xs font-medium ${
                      !f.present ? "text-white/25" : f.s > 0.05 ? "text-emerald-300" : f.s < -0.05 ? "text-rose-300" : "text-white/50"
                    }`}
                  >
                    {f.present ? (f.s >= 0 ? "+" : "") + f.s.toFixed(2) : "n/a"}
                  </span>
                </span>
              </div>
              <FactorBar s={f.s} present={f.present} />
            </button>
            {open === f.key && (
              <p className="mt-1.5 mb-0.5 text-[11px] leading-snug text-white/50 pl-3.5 border-l border-white/10">
                {DECODE[f.key] ?? "—"}{" "}
                {f.present
                  ? `Currently leaning ${f.s > 0.05 ? "bullish" : f.s < -0.05 ? "bearish" : "neutral"}.`
                  : "No data for this factor right now — its weight is redistributed across the others."}
              </p>
            )}
          </div>
        ))}
      </div>

      <p className="text-[10px] text-white/30 mt-3">
        Bar = signal strength × direction; weights redistribute when a factor's data is missing.
        Weights are hand-set priors, not backtested — trust the direction, not the decimal.
      </p>
    </Card>
  );
}
