import { useMemo, useState } from "preact/hooks";
import type { McxData, MarketEvent } from "../lib/types";
import {
  cushionSigma,
  expectedMove,
  probabilityAbove,
  probabilityBelow,
  probabilityOfTouch,
} from "../lib/options";
import { Card, SectionTitle, fmtInt } from "./ui";

const KIND_ICON: Record<string, string> = {
  fomc: "🏛️", us_cpi: "📊", us_jobs: "👷", rbi: "🇮🇳", mcx_expiry: "⏳", other: "📌",
};

/**
 * Expected-move cone vs your sold strikes. Projects the ±1σ/±2σ range (scaling
 * with √time) out to expiry, overlays your sold CALL/PUT strikes, places event
 * markers on the time axis, and reports the probability of price finishing
 * beyond each strike (the seller's real risk) plus the chance of being touched.
 */
export function ExpectedMoveCone({ mcx, events = [] }: { mcx: McxData; events?: MarketEvent[] }) {
  const F = mcx.mcx.silverFut;
  const iv = mcx.options.atmIv;
  // Cone runs to the OPTION expiry (the contract being sold), not the future's.
  const dte = mcx.mcx.optionDte ?? mcx.mcx.dte;
  const tYears = dte != null ? dte / 365 : null;
  const ready = F !== null && iv !== null && tYears !== null && tYears > 0 && dte! > 0;

  const [callStrike, setCallStrike] = useState<string>(F ? String(Math.round((F * 1.08) / 1000) * 1000) : "");
  const [putStrike, setPutStrike] = useState<string>(F ? String(Math.round((F * 0.92) / 1000) * 1000) : "");

  const geom = useMemo(() => {
    if (!ready) return null;
    return { em1: expectedMove(F!, iv!, tYears!) };
  }, [ready, F, iv, tYears]);

  if (!ready || !geom) {
    return (
      <Card>
        <SectionTitle>Expected-move cone</SectionTitle>
        <p className="text-sm text-white/40">Waiting on MCX price, IV and DTE…</p>
      </Card>
    );
  }

  const ck = Number(callStrike);
  const pk = Number(putStrike);
  const hasCall = Number.isFinite(ck) && ck > 0;
  const hasPut = Number.isFinite(pk) && pk > 0;

  const W = 320, H = 200, padL = 6, padR = 58, padT = 14, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // Y range includes the ±2σ cone and any entered strikes (so far strikes show).
  const candidatesHi = [F! + 2.2 * geom.em1, hasCall ? ck : -Infinity, hasPut ? pk : -Infinity];
  const candidatesLo = [F! - 2.2 * geom.em1, hasCall ? ck : Infinity, hasPut ? pk : Infinity];
  const hi = Math.max(...candidatesHi);
  const lo = Math.min(...candidatesLo);
  const span = hi - lo || 1;
  const yOf = (price: number) => padT + (1 - (price - lo) / span) * plotH;
  const xOf = (frac: number) => padL + Math.max(0, Math.min(1, frac)) * plotW;

  // Cone edges scale with √time.
  const steps = 28;
  const band = (k: number, sign: 1 | -1) => {
    const pts: string[] = [];
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      const price = F! + sign * k * geom.em1 * Math.sqrt(frac);
      pts.push(`${xOf(frac).toFixed(1)},${yOf(price).toFixed(1)}`);
    }
    return pts;
  };
  const fillBand = (k: number) => {
    const up = band(k, 1);
    const dn = band(k, -1).reverse();
    return [...up, ...dn].join(" ");
  };

  const today = Date.now();
  const upcoming = events
    .map((e) => ({ ...e, frac: (new Date(e.date).getTime() - today) / (dte! * 86400000) }))
    .filter((e) => e.frac >= 0 && e.frac <= 1);

  function strikeRow(label: "CALL" | "PUT", raw: string) {
    const k = Number(raw);
    if (!Number.isFinite(k) || k <= 0) return null;
    const cush = cushionSigma(F!, k, iv!, tYears!);
    const pot = probabilityOfTouch(F!, k, iv!, tYears!);
    const beyond = label === "CALL" ? probabilityAbove(F!, k, iv!, tYears!) : probabilityBelow(F!, k, iv!, tYears!);
    const tone = beyond < 0.1 ? "text-emerald-300" : beyond < 0.25 ? "text-amber-300" : "text-rose-300";
    return (
      <div className="rounded-lg bg-black/30 px-3 py-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-white/70">
            Sold {label} <span className="tnum text-white font-semibold">{fmtInt(k)}</span>
          </span>
          <span className={`tnum font-semibold ${tone}`}>{cush.toFixed(2)}σ away</span>
        </div>
        <div className="mt-1 flex gap-4 text-[11px]">
          <span>
            <span className="text-white/40">finish {label === "CALL" ? "above" : "below"}: </span>
            <span className={`tnum font-semibold ${tone}`}>{(beyond * 100).toFixed(1)}%</span>
          </span>
          <span>
            <span className="text-white/40">touched: </span>
            <span className="tnum text-white/80">{(pot * 100).toFixed(0)}%</span>
          </span>
        </div>
      </div>
    );
  }

  return (
    <Card>
      <SectionTitle>Expected-move cone vs your strikes</SectionTitle>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="block">
        <polygon points={fillBand(2)} className="fill-sky-400/5" />
        <polygon points={fillBand(1)} className="fill-sky-400/15" />
        <polyline points={band(1, 1).join(" ")} className="stroke-sky-400/70" strokeWidth="1.3" fill="none" />
        <polyline points={band(1, -1).join(" ")} className="stroke-sky-400/70" strokeWidth="1.3" fill="none" />
        <polyline points={band(2, 1).join(" ")} className="stroke-sky-400/30" strokeWidth="1" strokeDasharray="3 3" fill="none" />
        <polyline points={band(2, -1).join(" ")} className="stroke-sky-400/30" strokeWidth="1" strokeDasharray="3 3" fill="none" />

        {/* current price */}
        <line x1={padL} y1={yOf(F!)} x2={W - padR} y2={yOf(F!)} className="stroke-white/40" strokeWidth="1" />
        <text x={W - padR + 3} y={yOf(F!) + 3} className="fill-white/70" style={{ fontSize: 9 }}>{fmtInt(F)}</text>
        <text x={W - padR + 3} y={yOf(F! + geom.em1) + 3} className="fill-sky-300/70" style={{ fontSize: 8 }}>+1σ</text>
        <text x={W - padR + 3} y={yOf(F! - geom.em1) + 3} className="fill-sky-300/70" style={{ fontSize: 8 }}>−1σ</text>

        {/* event markers on the time axis */}
        {upcoming.map((e, i) => (
          <g key={i}>
            <line x1={xOf(e.frac)} y1={padT} x2={xOf(e.frac)} y2={padT + plotH} stroke="#fbbf24" strokeWidth="1" strokeDasharray="2 3" opacity="0.5" />
            <text x={xOf(e.frac)} y={padT + plotH + 16} textAnchor="middle" style={{ fontSize: 10 }}>{KIND_ICON[e.kind] ?? "📌"}</text>
          </g>
        ))}

        {/* sold strikes */}
        {hasCall && (
          <g>
            <line x1={padL} y1={yOf(ck)} x2={W - padR} y2={yOf(ck)} stroke="#fb7185" strokeWidth="1.4" strokeDasharray="5 2" />
            <text x={W - padR + 3} y={yOf(ck) + 3} fill="#fb7185" style={{ fontSize: 8, fontWeight: 600 }}>CE</text>
          </g>
        )}
        {hasPut && (
          <g>
            <line x1={padL} y1={yOf(pk)} x2={W - padR} y2={yOf(pk)} stroke="#34d399" strokeWidth="1.4" strokeDasharray="5 2" />
            <text x={W - padR + 3} y={yOf(pk) + 3} fill="#34d399" style={{ fontSize: 8, fontWeight: 600 }}>PE</text>
          </g>
        )}
        <text x={padL} y={H - 4} className="fill-white/30" style={{ fontSize: 8 }}>now</text>
        <text x={W - padR} y={H - 4} textAnchor="end" className="fill-white/30" style={{ fontSize: 8 }}>expiry · {dte}d</text>
      </svg>

      <div className="grid grid-cols-2 gap-2 mt-2">
        <label className="text-xs text-white/50">
          Sold CALL strike
          <input type="number" value={callStrike} onInput={(e) => setCallStrike((e.target as HTMLInputElement).value)}
            className="mt-1 w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1 text-sm tnum text-white" />
        </label>
        <label className="text-xs text-white/50">
          Sold PUT strike
          <input type="number" value={putStrike} onInput={(e) => setPutStrike((e.target as HTMLInputElement).value)}
            className="mt-1 w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1 text-sm tnum text-white" />
        </label>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-1.5">
        {strikeRow("CALL", callStrike)}
        {strikeRow("PUT", putStrike)}
      </div>

      <p className="text-[10px] text-white/30 mt-2">
        ±1σ ≈ {fmtInt(geom.em1)} over {dte} days at {(iv! * 100).toFixed(0)}% IV. "Finish above/below" =
        chance you're breached at expiry (ITM). "Touched" = chance it's reached anytime before. 🟡 = event.
      </p>
    </Card>
  );
}
