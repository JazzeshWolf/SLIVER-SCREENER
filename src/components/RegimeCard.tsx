import type { Horizon, HorizonScore, RegimeResult } from "../lib/types";
import type { TrackResult } from "../lib/track";
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

export function RegimeCard({
  regime,
  scores,
  track,
}: {
  regime: RegimeResult;
  scores: Record<Horizon, HorizonScore>;
  track?: TrackResult | null;
}) {
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

      <div className="mt-3">
        <ScoreBar score={decision.score} />
      </div>

      {track && (track.w1.n >= 8 || track.m1.n >= 8) && (
        <p className="mt-2 text-[10px] text-white/40 leading-snug">
          <span className="text-white/60 font-medium">Self-check</span> (walk-forward, last ~{track.sampleDays}d):{" "}
          {track.w1.n >= 8 && (
            <>1W lean right <span className={track.w1.rate >= 0.5 ? "text-emerald-300" : "text-rose-300"}>{Math.round(track.w1.rate * 100)}%</span> of {track.w1.n} signals</>
          )}
          {track.w1.n >= 8 && track.m1.n >= 8 && " · "}
          {track.m1.n >= 8 && (
            <>1M right <span className={track.m1.rate >= 0.5 ? "text-emerald-300" : "text-rose-300"}>{Math.round(track.m1.rate * 100)}%</span> of {track.m1.n}</>
          )}
          {" — measured on this app's own data; a consistency check, not a promise."}
        </p>
      )}

    </Card>
  );
}
