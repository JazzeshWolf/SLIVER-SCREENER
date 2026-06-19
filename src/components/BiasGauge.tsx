import type { HorizonScore } from "../lib/types";

// Speedometer-style bias gauge. Needle maps score (-10..+10) to a 180° sweep:
// far left = bearish (red), top = neutral, far right = bullish (green).

const SEGMENTS = [
  { color: "#dc2626" }, // bearish
  { color: "#f97316" },
  { color: "#f59e0b" },
  { color: "#eab308" },
  { color: "#a3e635" },
  { color: "#4ade80" },
  { color: "#16a34a" }, // bullish
];

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
}

function arcPath(cx: number, cy: number, rOuter: number, rInner: number, a0: number, a1: number) {
  const p0 = polar(cx, cy, rOuter, a0);
  const p1 = polar(cx, cy, rOuter, a1);
  const q1 = polar(cx, cy, rInner, a1);
  const q0 = polar(cx, cy, rInner, a0);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  // a0 > a1 (we sweep from 180° down to 0°), so use sweep-flag 1 for outer, 0 for inner.
  return [
    `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `L ${q1.x.toFixed(2)} ${q1.y.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${q0.x.toFixed(2)} ${q0.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

export function BiasGauge({
  hs,
  size = 150,
}: {
  hs: HorizonScore;
  size?: number;
}) {
  const cx = 100;
  const cy = 92;
  const rOuter = 86;
  const rInner = 58;
  const score = Math.max(-10, Math.min(10, hs.score));
  const f = (score + 10) / 20; // 0..1
  const needleAngle = 180 - f * 180; // 180°(left) -> 0°(right)

  const tone =
    hs.bucket === "bullish" ? "#22c55e" : hs.bucket === "bearish" ? "#ef4444" : "#facc15";
  const label = hs.bucket === "bullish" ? "BULLISH" : hs.bucket === "bearish" ? "BEARISH" : "NEUTRAL";

  const n = SEGMENTS.length;
  const tip = polar(cx, cy, rOuter - 8, needleAngle);
  const baseL = polar(cx, cy, 9, needleAngle + 90);
  const baseR = polar(cx, cy, 9, needleAngle - 90);

  const lowConf = hs.confidence < 0.25;

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size * 0.78} viewBox="0 0 200 132" className="overflow-visible">
        {SEGMENTS.map((seg, i) => {
          const a0 = 180 - (i / n) * 180;
          const a1 = 180 - ((i + 1) / n) * 180;
          return <path key={i} d={arcPath(cx, cy, rOuter, rInner, a0, a1)} fill={seg.color} opacity={lowConf ? 0.28 : 0.92} />;
        })}
        {/* needle */}
        <polygon
          points={`${baseL.x.toFixed(1)},${baseL.y.toFixed(1)} ${tip.x.toFixed(1)},${tip.y.toFixed(1)} ${baseR.x.toFixed(1)},${baseR.y.toFixed(1)}`}
          fill="#e6edf3"
        />
        <circle cx={cx} cy={cy} r={10} fill="#0a0e14" stroke="#e6edf3" strokeWidth={2} />
        {/* value */}
        <text x={cx} y={cy - 22} textAnchor="middle" fill={tone} style={{ fontSize: 26, fontWeight: 800 }}>
          {score > 0 ? "+" : ""}
          {score.toFixed(1)}
        </text>
        <text x={cx} y={cy + 24} textAnchor="middle" fill={tone} style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>
          {label}
        </text>
      </svg>
      <div className="text-center -mt-1">
        <div className="text-[11px] uppercase tracking-widest text-white/50 font-semibold">{hs.horizon}</div>
        <div className="text-[10px] text-white/30">
          {lowConf ? "warming up" : `confidence ${(hs.confidence * 100).toFixed(0)}%`}
        </div>
      </div>
    </div>
  );
}
