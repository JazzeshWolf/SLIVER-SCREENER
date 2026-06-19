import type { Point } from "../lib/types";

/** Minimal dependency-free SVG sparkline. */
export function Sparkline({
  data,
  width = 120,
  height = 36,
  stroke = "#38bdf8",
  band,
}: {
  data: Point[] | number[];
  width?: number;
  height?: number;
  stroke?: string;
  band?: { lo: number; hi: number; mean?: number };
}) {
  const values = data.map((d) => (typeof d === "number" ? d : d.v)).filter(Number.isFinite);
  if (values.length < 2) {
    return <div className="text-white/30 text-xs h-9 flex items-center">no data</div>;
  }
  const lo = band ? Math.min(band.lo, ...values) : Math.min(...values);
  const hi = band ? Math.max(band.hi, ...values) : Math.max(...values);
  const span = hi - lo || 1;
  const pad = 2;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - 2 * pad);
  const y = (v: number) => pad + (1 - (v - lo) / span) * (height - 2 * pad);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const up = values[values.length - 1] >= values[0];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      {band && (
        <rect
          x={0}
          y={y(band.hi)}
          width={width}
          height={Math.max(0, y(band.lo) - y(band.hi))}
          fill="#ffffff10"
        />
      )}
      {band?.mean !== undefined && (
        <line x1={0} x2={width} y1={y(band.mean)} y2={y(band.mean)} stroke="#ffffff30" strokeDasharray="2 2" />
      )}
      <path d={d} fill="none" stroke={stroke || (up ? "#34d399" : "#fb7185")} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
