import type { PremiumSellScore } from "../lib/types";
import { Card } from "./ui";

const BAND = {
  green: { ring: "stroke-emerald-400", text: "text-emerald-300", dot: "🟢", label: "SELL" },
  amber: { ring: "stroke-amber-400", text: "text-amber-300", dot: "🟡", label: "WAIT" },
  red: { ring: "stroke-rose-400", text: "text-rose-300", dot: "🔴", label: "AVOID" },
};

export function SellWindow({ premium, ivEstimated }: { premium: PremiumSellScore; ivEstimated?: boolean }) {
  const b = BAND[premium.band];
  const r = 34;
  const c = 2 * Math.PI * r;
  const dash = (premium.score / 100) * c;

  return (
    <Card className="flex-1">
      <div className="text-[10px] uppercase tracking-wider text-white/40">Premium Sell Window</div>
      <div className="flex items-center gap-3 mt-2">
        <svg width="84" height="84" viewBox="0 0 84 84" className="-rotate-90">
          <circle cx="42" cy="42" r={r} fill="none" className="stroke-white/10" strokeWidth="7" />
          <circle
            cx="42"
            cy="42"
            r={r}
            fill="none"
            className={b.ring}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c}`}
          />
          <text
            x="42"
            y="46"
            textAnchor="middle"
            className={`rotate-90 origin-center fill-current ${b.text}`}
            style={{ fontSize: "20px", fontWeight: 700 }}
            transform="rotate(90 42 42)"
          >
            {premium.score}
          </text>
        </svg>
        <div>
          <div className={`text-lg font-bold ${b.text}`}>
            {b.dot} {b.label}
          </div>
          <div className="text-xs text-white/50 mt-0.5 max-w-[10rem]">{premium.note}</div>
        </div>
      </div>
      {/* The two gates. These sit ABOVE the component grid because either one
          overrides the score outright — a rich IV rank must not read as "sell"
          when you're paid less than the metal moves, or when a print that
          routinely gaps it lands before you could get out. */}
      <div className="mt-2 space-y-1">
        <Gate
          label="VRP"
          value={
            premium.vrp.vrp == null
              ? "—"
              : `${premium.vrp.vrp > 0 ? "+" : ""}${premium.vrp.vrp.toFixed(1)} pts`
          }
          tone={
            premium.vrp.blocked
              ? "bad"
              : premium.vrp.proxy
                ? "warn"
                : premium.vrp.band === "clear" || premium.vrp.band === "standard"
                  ? "good"
                  : "warn"
          }
          state={premium.vrp.proxy ? "PROXY" : premium.vrp.band.toUpperCase()}
          note={premium.vrp.note}
        />
        <Gate
          label="Events"
          value={premium.events.daysAway == null ? "clear" : `${premium.events.daysAway}d`}
          tone={premium.events.vetoed ? "bad" : premium.events.inWindow.length ? "warn" : "good"}
          state={premium.events.vetoed ? "VETO" : premium.events.inWindow.length ? "IN WINDOW" : "CLEAR"}
          note={premium.events.note}
        />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-white/50">
        <Comp label="IV rank" v={premium.components.ivRank} suffix="" />
        <Comp label="IV/RV" v={premium.components.ivRvRatio} scale01 />
        <Comp label="Theta zone" v={premium.components.thetaZone} scale01 />
        <Comp label="Event clear" v={premium.components.eventClear} bool />
      </div>
      {premium.confidence < 0.75 && (
        <div className="mt-1 text-[10px] text-amber-300/70">
          partial inputs · confidence {(premium.confidence * 100).toFixed(0)}%
        </div>
      )}
      {ivEstimated && (
        <div className="mt-1 text-[10px] text-amber-300/70">
          IV rank is from realized vol (no live option price) — treat as a proxy.
        </div>
      )}
    </Card>
  );
}

const GATE_TONE = {
  good: "text-emerald-300/90 border-emerald-400/25 bg-emerald-400/5",
  warn: "text-amber-300/90 border-amber-400/25 bg-amber-400/5",
  bad: "text-rose-300/90 border-rose-400/30 bg-rose-400/10",
};

/**
 * One hard gate. Shows its state word and the one-line reason, because a gate
 * that only shows a colour teaches you to ignore it — the reason is the point.
 */
function Gate({
  label,
  value,
  state,
  tone,
  note,
}: {
  label: string;
  value: string;
  state: string;
  tone: keyof typeof GATE_TONE;
  note: string;
}) {
  return (
    <div className={`rounded-lg border px-2 py-1.5 ${GATE_TONE[tone]}`}>
      <div className="flex items-baseline justify-between gap-2 text-[10px]">
        <span className="uppercase tracking-wide opacity-70">{label}</span>
        <span className="flex items-baseline gap-1.5">
          <span className="tnum">{value}</span>
          <span className="font-semibold">{state}</span>
        </span>
      </div>
      <div className="text-[10px] leading-snug opacity-70 mt-0.5">{note}</div>
    </div>
  );
}

function Comp({
  label,
  v,
  suffix = "",
  scale01 = false,
  bool = false,
}: {
  label: string;
  v: number | null;
  suffix?: string;
  scale01?: boolean;
  bool?: boolean;
}) {
  let display = "—";
  if (v !== null && Number.isFinite(v)) {
    if (bool) display = v >= 1 ? "clear" : "soon";
    else if (scale01) display = `${Math.round(v * 100)}`;
    else display = `${Math.round(v)}${suffix}`;
  }
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span className="text-white/70 tnum">{display}</span>
    </div>
  );
}
