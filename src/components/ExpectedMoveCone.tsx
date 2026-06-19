import { useMemo, useState } from "preact/hooks";
import type { McxData } from "../lib/types";
import { cushionSigma, expectedMove, probabilityOfTouch } from "../lib/options";
import { Card, SectionTitle, fmtInt } from "./ui";

/**
 * Expected-move cone vs your sold strikes. Projects ±1σ/±2σ from current
 * futures price out to expiry and shows, for each entered strike, its cushion
 * in σ and its probability of being *touched* before expiry.
 */
export function ExpectedMoveCone({ mcx }: { mcx: McxData }) {
  const F = mcx.mcx.silverFut;
  const iv = mcx.options.atmIv;
  const dte = mcx.mcx.dte;
  const t = dte !== null ? dte / 365 : null;

  const [putStrike, setPutStrike] = useState<string>(
    F ? String(Math.round((F * 0.94) / 1000) * 1000) : "",
  );
  const [callStrike, setCallStrike] = useState<string>(
    F ? String(Math.round((F * 1.06) / 1000) * 1000) : "",
  );

  const ready = F !== null && iv !== null && t !== null && t > 0;

  const geom = useMemo(() => {
    if (!ready) return null;
    const em1 = expectedMove(F!, iv!, t!);
    const em2 = 2 * em1;
    return { em1, em2 };
  }, [ready, F, iv, t]);

  if (!ready || !geom) {
    return (
      <Card>
        <SectionTitle>Expected-move cone</SectionTitle>
        <p className="text-sm text-white/40">
          Needs MCX futures price, ATM IV and DTE — waiting on data.
        </p>
      </Card>
    );
  }

  const width = 320;
  const height = 170;
  const padX = 8;
  const midY = height / 2;
  const yScale = (height / 2 - 16) / geom.em2; // px per ₹ for ±2σ to fit

  const priceToY = (p: number) => midY - (p - F!) * yScale;
  const cone = (sigmaMult: number, sign: number) => {
    const top = `${padX},${midY}`;
    const tip = `${width - padX},${priceToY(F! + sign * sigmaMult * geom.em1)}`;
    return `${top} ${tip}`;
  };

  function strikeRow(label: string, raw: string) {
    const k = Number(raw);
    if (!Number.isFinite(k) || k <= 0) return null;
    const cush = cushionSigma(F!, k, iv!, t!);
    const pot = probabilityOfTouch(F!, k, iv!, t!);
    const safe = cush >= 1.5 ? "text-emerald-300" : cush >= 1 ? "text-amber-300" : "text-rose-300";
    return (
      <div className="flex items-center justify-between text-xs py-0.5">
        <span className="text-white/60">
          {label} <span className="tnum text-white/80">{fmtInt(k)}</span>
        </span>
        <span className="flex gap-3">
          <span className={`tnum ${safe}`}>{cush.toFixed(2)}σ cushion</span>
          <span className="tnum text-white/60">{(pot * 100).toFixed(0)}% touch</span>
        </span>
      </div>
    );
  }

  const pk = Number(putStrike);
  const ck = Number(callStrike);

  return (
    <Card>
      <SectionTitle>Expected-move cone vs your strikes</SectionTitle>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="block">
        {/* filled ±2σ then ±1σ cones (apex at current price, widening to expiry) */}
        <polygon
          points={`${padX},${midY} ${cone(2, 1).split(" ")[1]} ${cone(2, -1).split(" ")[1]}`}
          className="fill-sky-400/5"
        />
        <polygon
          points={`${padX},${midY} ${cone(1, 1).split(" ")[1]} ${cone(1, -1).split(" ")[1]}`}
          className="fill-sky-400/10"
        />
        <polyline points={cone(2, 1)} className="stroke-sky-400/30" strokeWidth="1" strokeDasharray="3 3" fill="none" />
        <polyline points={cone(2, -1)} className="stroke-sky-400/30" strokeWidth="1" strokeDasharray="3 3" fill="none" />
        <polyline points={cone(1, 1)} className="stroke-sky-400/70" strokeWidth="1.5" fill="none" />
        <polyline points={cone(1, -1)} className="stroke-sky-400/70" strokeWidth="1.5" fill="none" />
        {/* current price line */}
        <line x1={padX} y1={midY} x2={width - padX} y2={midY} className="stroke-white/40" strokeWidth="1" />
        <text x={padX} y={midY - 4} className="fill-white/50" style={{ fontSize: "9px" }}>
          {fmtInt(F)}
        </text>

        {/* sold strikes */}
        {Number.isFinite(ck) && ck > 0 && priceToY(ck) > 6 && (
          <StrikeMark y={priceToY(ck)} width={width} label={`CE ${fmtInt(ck)}`} tone="rose" />
        )}
        {Number.isFinite(pk) && pk > 0 && priceToY(pk) < height - 6 && (
          <StrikeMark y={priceToY(pk)} width={width} label={`PE ${fmtInt(pk)}`} tone="emerald" />
        )}
        <text x={width - padX} y={priceToY(F! + geom.em1) - 2} textAnchor="end" className="fill-sky-300/70" style={{ fontSize: "9px" }}>
          +1σ {fmtInt(F! + geom.em1)}
        </text>
        <text x={width - padX} y={priceToY(F! - geom.em1) + 9} textAnchor="end" className="fill-sky-300/70" style={{ fontSize: "9px" }}>
          −1σ {fmtInt(F! - geom.em1)}
        </text>
      </svg>

      <div className="grid grid-cols-2 gap-2 mt-2">
        <label className="text-xs text-white/50">
          Sold CALL strike
          <input
            type="number"
            value={callStrike}
            onInput={(e) => setCallStrike((e.target as HTMLInputElement).value)}
            className="mt-1 w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1 text-sm tnum text-white"
          />
        </label>
        <label className="text-xs text-white/50">
          Sold PUT strike
          <input
            type="number"
            value={putStrike}
            onInput={(e) => setPutStrike((e.target as HTMLInputElement).value)}
            className="mt-1 w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1 text-sm tnum text-white"
          />
        </label>
      </div>

      <div className="mt-2">
        {strikeRow("CALL", callStrike)}
        {strikeRow("PUT", putStrike)}
      </div>
      <p className="text-[10px] text-white/30 mt-1">
        ±1σ ≈ {fmtInt(geom.em1)} over {dte} days at {(iv! * 100).toFixed(0)}% IV. "Touch" = chance the
        strike is reached before expiry (higher than chance of finishing ITM).
      </p>
    </Card>
  );
}

function StrikeMark({
  y,
  width,
  label,
  tone,
}: {
  y: number;
  width: number;
  label: string;
  tone: "rose" | "emerald";
}) {
  const color = tone === "rose" ? "#fb7185" : "#34d399";
  return (
    <g>
      <line x1={8} y1={y} x2={width - 8} y2={y} stroke={color} strokeWidth="1.5" strokeDasharray="4 2" />
      <text x={width - 10} y={y - 3} textAnchor="end" fill={color} style={{ fontSize: "9px", fontWeight: 600 }}>
        {label}
      </text>
    </g>
  );
}
