import type { McxData } from "../lib/types";
import { iv30d, fearZone } from "../lib/vix";
import { Card, SectionTitle } from "./ui";

// Speedometer arc helpers (same math as BiasGauge): 180° sweep, left→right.
function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
}
function arcPath(cx: number, cy: number, rO: number, rI: number, a0: number, a1: number) {
  const p0 = polar(cx, cy, rO, a0), p1 = polar(cx, cy, rO, a1);
  const q1 = polar(cx, cy, rI, a1), q0 = polar(cx, cy, rI, a0);
  return [
    `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)}`,
    `A ${rO} ${rO} 0 0 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `L ${q1.x.toFixed(2)} ${q1.y.toFixed(2)}`,
    `A ${rI} ${rI} 0 0 0 ${q0.x.toFixed(2)} ${q0.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

// Calm (left) → extreme fear (right).
const ZONES = ["#22c55e", "#a3e635", "#eab308", "#f97316", "#ef4444"];

/**
 * Silver's fear gauge = its own option-implied vol (the India-VIX analog; no
 * official Silver VIX exists). Headline is a 30-day constant-maturity ATM IV;
 * the needle sits at the IV percentile vs history (calm → fear).
 */
export function FearGauge({ mcx }: { mcx: McxData }) {
  const vix = iv30d(mcx.expiries);
  const o = mcx.options;
  const pct = o.ivPercentile; // 0..100, drives the needle + zone
  const zone = fearZone(pct);
  const rankEstimated = o.ivRankEstimated ?? true;

  const ivPctNum = vix ? vix.iv * 100 : o.atmIv != null ? o.atmIv * 100 : null;
  const ivRvGap = vix != null && o.rv20 != null ? (vix.iv - o.rv20) * 100 : null; // vol points

  const cx = 100, cy = 92, rO = 86, rI = 58, n = ZONES.length;
  const f = Math.max(0, Math.min(1, (pct ?? 50) / 100));
  const needle = 180 - f * 180;
  const tip = polar(cx, cy, rO - 8, needle);
  const bl = polar(cx, cy, 9, needle + 90);
  const br = polar(cx, cy, 9, needle - 90);

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <SectionTitle>Silver fear gauge — option IV</SectionTitle>
        <span className="text-[10px] uppercase tracking-wider text-white/30">
          {vix?.source === "30d" ? "30-day" : "front"}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <svg width="164" height="128" viewBox="0 0 200 132" className="overflow-visible shrink-0">
          {ZONES.map((c, i) => (
            <path
              key={i}
              d={arcPath(cx, cy, rO, rI, 180 - (i / n) * 180, 180 - ((i + 1) / n) * 180)}
              fill={c}
              opacity={pct == null ? 0.25 : 0.9}
            />
          ))}
          <polygon
            points={`${bl.x.toFixed(1)},${bl.y.toFixed(1)} ${tip.x.toFixed(1)},${tip.y.toFixed(1)} ${br.x.toFixed(1)},${br.y.toFixed(1)}`}
            fill="#e6edf3"
          />
          <circle cx={cx} cy={cy} r={10} fill="#0a0e14" stroke="#e6edf3" strokeWidth={2} />
          <text x={cx} y={cy - 20} textAnchor="middle" fill={zone.color} style={{ fontSize: 30, fontWeight: 800 }}>
            {ivPctNum != null ? `${ivPctNum.toFixed(0)}%` : "—"}
          </text>
          <text x={cx} y={cy + 22} textAnchor="middle" fill={zone.color} style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>
            {zone.label.toUpperCase()}
          </text>
        </svg>

        <div className="min-w-0">
          <div className="text-xs text-white/70 leading-snug">{zone.sellerNote}</div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-white/50">
            <div className="flex justify-between"><span>IV rank</span><span className="tnum text-white/70">{o.ivRank != null ? Math.round(o.ivRank) : "—"}</span></div>
            <div className="flex justify-between"><span>Percentile</span><span className="tnum text-white/70">{pct != null ? Math.round(pct) : "—"}</span></div>
            <div className="flex justify-between col-span-2">
              <span>IV − realized (fear premium)</span>
              <span className={`tnum ${ivRvGap == null ? "text-white/70" : ivRvGap >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {ivRvGap != null ? `${ivRvGap >= 0 ? "+" : ""}${ivRvGap.toFixed(1)} vol pts` : "—"}
              </span>
            </div>
          </div>
        </div>
      </div>

      <p className="text-[10px] text-white/30 mt-2 pt-2 border-t border-white/5">
        No official “Silver VIX” exists — this is silver's own option-implied vol (the India-VIX
        analog), 30-day constant-maturity from the MCX chain.
        {(rankEstimated || vix?.estimated) && " Rank is vs realized-vol history (proxy) until ~a month of real IV accrues."}
      </p>
    </Card>
  );
}
