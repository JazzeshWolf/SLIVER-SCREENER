import type { McxData } from "../lib/types";
import { pivotByStrike, fmtOi, type StrikeRow } from "../lib/chain";
import { Card } from "./ui";

const WINDOW = 18; // strikes each side of ATM

export function OptionChainTable({ mcx }: { mcx: McxData }) {
  const chain = mcx.options.chain ?? [];
  const spot = mcx.mcx.silverFut;
  if (!chain.length || spot == null) {
    return (
      <Card>
        <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2">Option chain</div>
        <p className="text-sm text-white/40">No live option chain for this expiry.</p>
      </Card>
    );
  }

  const all = pivotByStrike(chain);
  // Window around the strike nearest spot.
  const atmIdx = all.reduce((best, r, i) => (Math.abs(r.strike - spot) < Math.abs(all[best].strike - spot) ? i : best), 0);
  const rows = all.slice(Math.max(0, atmIdx - WINDOW), atmIdx + WINDOW + 1);

  const maxOi = Math.max(1, ...rows.flatMap((r) => [r.ce?.oi ?? 0, r.pe?.oi ?? 0]));
  const maxPain = mcx.gex?.maxPain ?? null;
  const callWall = mcx.gex?.callWall ?? null;
  const putWall = mcx.gex?.putWall ?? null;

  return (
    <Card className="px-2">
      <div className="flex items-center justify-between px-2 mb-1">
        <div className="text-[10px] uppercase tracking-wider text-white/40">Option chain</div>
        <div className="text-[10px] text-white/30">total OI</div>
      </div>
      <div className="grid grid-cols-[1fr_2.75rem_4rem_2.75rem_1fr] items-center text-[9px] text-white/30 px-2 pb-1">
        <span className="text-rose-300/60">CALLS · resist</span>
        <span className="text-right">LTP</span>
        <span className="text-center">Strike · IV</span>
        <span className="text-left">LTP</span>
        <span className="text-right text-emerald-300/60">PUTS · support</span>
      </div>

      <div className="max-h-[62vh] overflow-y-auto">
        {rows.map((r, i) => {
          const isSpotBreak = i > 0 && rows[i - 1].strike > spot && r.strike <= spot;
          return (
            <div key={r.strike}>
              {isSpotBreak && (
                <div className="flex items-center gap-2 my-0.5">
                  <div className="flex-1 border-t border-dashed border-sky-400/40" />
                  <span className="text-[9px] font-semibold text-sky-300 bg-sky-500/15 rounded px-1.5 py-0.5">
                    SPOT {Math.round(spot).toLocaleString("en-IN")}
                  </span>
                  <div className="flex-1 border-t border-dashed border-sky-400/40" />
                </div>
              )}
              <Row r={r} maxOi={maxOi} spot={spot} maxPain={maxPain} callWall={callWall} putWall={putWall} />
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-1 text-[9px] text-white/30 px-2 pt-2 mt-1 border-t border-white/5">
        <span><span className="inline-block w-2 h-2 rounded-sm bg-rose-500/40 align-middle" /> call OI</span>
        <span className="text-center text-amber-300/70">gold = max pain</span>
        <span className="text-right"><span className="inline-block w-2 h-2 rounded-sm bg-emerald-500/40 align-middle" /> put OI</span>
        <span>shaded = ITM</span>
        <span className="text-center text-white/30">brightest = wall</span>
        <span className="text-right">·</span>
      </div>
    </Card>
  );
}

function Row({
  r, maxOi, spot, maxPain, callWall, putWall,
}: {
  r: StrikeRow;
  maxOi: number;
  spot: number;
  maxPain: number | null;
  callWall: number | null;
  putWall: number | null;
}) {
  const callItm = r.strike < spot; // call ITM below spot
  const putItm = r.strike > spot;
  const isMaxPain = maxPain != null && r.strike === maxPain;
  const cw = r.strike === callWall;
  const pw = r.strike === putWall;
  const cePct = ((r.ce?.oi ?? 0) / maxOi) * 100;
  const pePct = ((r.pe?.oi ?? 0) / maxOi) * 100;

  const iv = r.ce?.iv ?? r.pe?.iv ?? null;

  return (
    <div className={`grid grid-cols-[1fr_2.75rem_4rem_2.75rem_1fr] items-center py-0.5 rounded ${isMaxPain ? "bg-amber-400/10 ring-1 ring-amber-400/30" : ""}`}>
      {/* Call OI bar (right-anchored) + OI number */}
      <div className={`relative h-5 flex items-center ${callItm ? "bg-white/[0.03]" : ""}`}>
        <div className={`absolute right-0 h-3.5 rounded-sm ${cw ? "bg-rose-500/70" : "bg-rose-500/30"}`} style={{ width: `${cePct}%` }} />
        <span className="relative z-10 pl-1 text-[10px] tnum text-white/60">{fmtOi(r.ce?.oi)}</span>
      </div>
      <span className="text-[10px] tnum text-white/50 text-right pr-1">{r.ce ? Math.round(r.ce.ltp).toLocaleString("en-IN") : "—"}</span>
      {/* Strike + IV */}
      <div className="text-center">
        <div className="text-[11px] font-semibold tnum text-white/80">{r.strike.toLocaleString("en-IN")}</div>
        {iv != null && <div className="text-[8px] tnum text-white/30">{(iv * 100).toFixed(1)}</div>}
      </div>
      <span className="text-[10px] tnum text-white/50 text-left pl-1">{r.pe ? Math.round(r.pe.ltp).toLocaleString("en-IN") : "—"}</span>
      {/* Put OI bar (left-anchored) + OI number */}
      <div className={`relative h-5 flex items-center justify-end ${putItm ? "bg-white/[0.03]" : ""}`}>
        <div className={`absolute left-0 h-3.5 rounded-sm ${pw ? "bg-emerald-500/70" : "bg-emerald-500/30"}`} style={{ width: `${pePct}%` }} />
        <span className="relative z-10 pr-1 text-[10px] tnum text-white/60">{fmtOi(r.pe?.oi)}</span>
      </div>
    </div>
  );
}
