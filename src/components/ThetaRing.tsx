import type { McxData } from "../lib/types";
import { thetaZone } from "../lib/scoring";
import { Card } from "./ui";

/** Theta decay countdown ring: arc = DTE, color = theta sweet-spot vs gamma risk. */
export function ThetaRing({ mcx }: { mcx: McxData }) {
  const dte = mcx.mcx.dte;
  const zone = thetaZone(dte);
  const maxDte = 45; // ring fills relative to a typical monthly cycle
  const frac = dte === null ? 0 : Math.min(1, dte / maxDte);

  let tone = "stroke-emerald-400";
  let label = "sweet spot";
  let textTone = "text-emerald-300";
  if (dte !== null) {
    if (dte < 7) {
      tone = "stroke-rose-400";
      label = "gamma danger";
      textTone = "text-rose-300";
    } else if (dte > 45) {
      tone = "stroke-sky-400";
      label = "far-dated";
      textTone = "text-sky-300";
    } else if (dte < 18 || dte > 40) {
      tone = "stroke-amber-400";
      label = "edge of zone";
      textTone = "text-amber-300";
    }
  }

  const r = 34;
  const c = 2 * Math.PI * r;
  const dash = frac * c;

  return (
    <Card className="flex-1">
      <div className="text-[10px] uppercase tracking-wider text-white/40">Theta Clock</div>
      <div className="flex items-center gap-3 mt-2">
        <svg width="84" height="84" viewBox="0 0 84 84" className="-rotate-90">
          <circle cx="42" cy="42" r={r} fill="none" className="stroke-white/10" strokeWidth="7" />
          <circle
            cx="42"
            cy="42"
            r={r}
            fill="none"
            className={tone}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c}`}
          />
          <text
            x="42"
            y="46"
            textAnchor="middle"
            className="rotate-90 origin-center fill-white"
            style={{ fontSize: "22px", fontWeight: 700 }}
            transform="rotate(90 42 42)"
          >
            {dte ?? "—"}
          </text>
        </svg>
        <div>
          <div className={`text-base font-bold ${textTone}`}>{label}</div>
          <div className="text-xs text-white/50 mt-0.5">
            {dte ?? "—"} DTE · expiry {mcx.mcx.expiry ?? "—"}
          </div>
          <div className="text-[11px] text-white/40 mt-1">
            theta favorability {zone === null ? "—" : `${Math.round(zone * 100)}%`}
          </div>
          {dte !== null && dte < 7 && (
            <div className="text-[10px] text-rose-300/80 mt-1">Roll / close — gamma risk high</div>
          )}
        </div>
      </div>
    </Card>
  );
}
