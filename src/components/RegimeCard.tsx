import { useState } from "preact/hooks";
import type { Horizon, HorizonScore, RegimeResult } from "../lib/types";
import { Card, Pill } from "./ui";

const REGIME_TONE: Record<string, "bull" | "bear" | "neutral" | "warn"> = {
  trend_up: "bull",
  trend_down: "bear",
  chop: "neutral",
  no_conviction: "warn",
};

function ScoreBar({ score }: { score: number }) {
  // -10..+10 mapped to a centered bar
  const pct = ((score + 10) / 20) * 100;
  const color = score >= 3 ? "bg-emerald-400" : score <= -3 ? "bg-rose-400" : "bg-sky-400";
  return (
    <div className="relative h-1.5 rounded-full bg-white/10 mt-1">
      <div className="absolute left-1/2 top-0 h-full w-px bg-white/30" />
      <div
        className={`absolute top-0 h-full rounded-full ${color}`}
        style={{
          left: score >= 0 ? "50%" : `${pct}%`,
          width: `${Math.abs(score) / 20 * 100}%`,
        }}
      />
    </div>
  );
}

function HorizonChip({ hs, emphasized }: { hs: HorizonScore; emphasized: boolean }) {
  const tone = hs.score >= 3 ? "text-emerald-300" : hs.score <= -3 ? "text-rose-300" : "text-sky-300";
  return (
    <div
      className={`flex-1 rounded-xl px-2 py-1.5 text-center ${
        emphasized ? "bg-white/10 ring-1 ring-white/20" : "bg-white/5"
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-white/40">{hs.horizon}</div>
      <div className={`text-lg font-bold tnum ${tone}`}>
        {hs.score > 0 ? "+" : ""}
        {hs.score.toFixed(1)}
      </div>
      <div className="text-[9px] text-white/30">conf {(hs.confidence * 100).toFixed(0)}%</div>
    </div>
  );
}

export function RegimeCard({
  regime,
  scores,
}: {
  regime: RegimeResult;
  scores: Record<Horizon, HorizonScore>;
}) {
  const [open, setOpen] = useState(false);
  const decision = scores[regime.dteHorizon];
  const anyPartial = Object.values(scores).some((s) => s.partial);

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-white/40">Regime</div>
          <div className="text-xl font-bold flex items-center gap-2">
            {regime.label}
            <Pill tone={REGIME_TONE[regime.regime]}>{regime.regime.replace("_", " ")}</Pill>
          </div>
        </div>
        {anyPartial && <Pill tone="warn">partial data</Pill>}
      </div>

      <div className="mt-2 text-sm text-white/70">
        Lean: <span className="text-white font-medium">{regime.structure}</span>
      </div>
      {!regime.directionalLeanAllowed && (
        <div className="mt-1 text-xs text-white/40">
          Decision horizon {regime.dteHorizon} below conviction threshold → default to range play.
        </div>
      )}

      <div className="mt-3 flex gap-2">
        {(["1D", "1W", "1M"] as Horizon[]).map((h) => (
          <HorizonChip key={h} hs={scores[h]} emphasized={h === regime.dteHorizon} />
        ))}
      </div>
      <div className="mt-3">
        <ScoreBar score={decision.score} />
      </div>

      <button
        onClick={() => setOpen((o) => !o)}
        className="mt-3 text-xs text-sky-300/80 hover:text-sky-200"
      >
        {open ? "▾ hide factor breakdown" : `▸ factor breakdown (${regime.dteHorizon})`}
      </button>

      {open && (
        <div className="mt-2 space-y-1">
          {decision.factors.map((f) => (
            <div key={f.key} className="flex items-center justify-between text-xs">
              <span className={f.present ? "text-white/70" : "text-white/30 line-through"}>
                {f.label}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-white/40 tnum">w {(f.weight * 100).toFixed(0)}%</span>
                <span
                  className={`tnum font-medium ${
                    f.s > 0.05 ? "text-emerald-300" : f.s < -0.05 ? "text-rose-300" : "text-white/50"
                  }`}
                >
                  {f.present ? (f.s >= 0 ? "+" : "") + f.s.toFixed(2) : "n/a"}
                </span>
              </span>
            </div>
          ))}
          <p className="text-[10px] text-white/30 pt-1">
            Weights are hand-set priors, not backtested. Trust the regime/divergence, not the decimal.
          </p>
        </div>
      )}
    </Card>
  );
}
