import type { Horizon, HorizonScore, RegimeResult } from "../lib/types";
import type { Outlook } from "../lib/outlook";
import { BiasGauge } from "./BiasGauge";
import { Card, Pill } from "./ui";

const REGIME_TONE: Record<string, "bull" | "bear" | "neutral" | "warn"> = {
  trend_up: "bull",
  trend_down: "bear",
  chop: "neutral",
  no_conviction: "warn",
};

const HORIZON_LABEL: Record<Horizon, string> = {
  "1D": "1 Day",
  "1W": "1 Week",
  "1M": "1 Month",
};

export function DirectionGauges({
  scores,
  regime,
  outlook,
  onOpenOutlook,
}: {
  scores: Record<Horizon, HorizonScore>;
  regime: RegimeResult;
  outlook?: Outlook | null;
  onOpenOutlook?: () => void;
}) {
  const warming = Object.values(scores).every((s) => s.confidence < 0.25);

  return (
    <Card className="bg-gradient-to-b from-[#141a24] to-[#11161f]">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold tracking-wide">Market Direction Bias</h2>
        <Pill tone={REGIME_TONE[regime.regime]}>{regime.label}</Pill>
      </div>

      <div className="grid grid-cols-3 gap-1">
        {(["1D", "1W", "1M"] as Horizon[]).map((h) => (
          <div key={h} className="flex flex-col items-center">
            <BiasGauge hs={scores[h]} size={118} />
            <div className="text-[10px] text-white/40 -mt-0.5">{HORIZON_LABEL[h]}</div>
          </div>
        ))}
      </div>

      <div className="mt-2 text-center text-sm">
        <span className="text-white/50">Play: </span>
        <span className="text-white font-medium">{regime.structure}</span>
      </div>

      {warming ? (
        <p className="mt-2 text-[11px] text-amber-300/80 text-center">
          Warming up — gauges sharpen once the next data refresh lands (history loading).
        </p>
      ) : (
        <p className="mt-2 text-[10px] text-white/30 text-center">
          {regime.dteHorizon} drives the play. Needle left = bearish, right = bullish.
        </p>
      )}

      {outlook && (
        <button
          onClick={onOpenOutlook}
          className="mt-3 w-full rounded-xl bg-white/5 hover:bg-white/10 active:bg-white/10 px-3 py-2 flex items-center justify-between gap-3 text-left transition-colors"
        >
          <span className="text-[11px] text-white/55 leading-snug">
            This is the <span className="text-white/85 font-medium">momentum core</span>. Full weighted
            read — adding CoT positioning, basis &amp; structural deficit — in Outlook.
          </span>
          <span className="flex flex-col items-end shrink-0">
            <Pill tone={outlook.leanTone}>{outlook.leanLabel}</Pill>
            <span className="text-[10px] text-white/35 mt-1 tnum">
              bias {outlook.netBias >= 0 ? "+" : ""}{outlook.netBias} · open →
            </span>
          </span>
        </button>
      )}
    </Card>
  );
}
