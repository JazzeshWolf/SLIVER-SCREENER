import type { McxData } from "../lib/types";
import { pcr, straddleAtm, skew25, oiWritten, hasOiChg, fmtOiSigned } from "../lib/chain";
import { Card, SectionTitle } from "./ui";

export function PositioningVol({ mcx }: { mcx: McxData }) {
  const chain = mcx.options.chain ?? [];
  if (!chain.length) return null;
  const o = mcx.options;
  const spot = mcx.mcx.fut;

  const ratio = pcr(chain);
  const pcrLabel = ratio == null ? "—" : ratio > 1.15 ? "put-heavy (support)" : ratio < 0.85 ? "call-heavy (pressure)" : "balanced";
  const straddle = straddleAtm(chain, o.atmStrike);
  const em = o.expectedMove1sd;
  const skew = skew25(chain, spot);
  const lo = spot != null && em != null ? spot - em : null;
  const hi = spot != null && em != null ? spot + em : null;
  const emPct = spot != null && em != null ? (em / spot) * 100 : null;
  const fmt = (n: number | null | undefined) => (n != null ? Math.round(n).toLocaleString("en-IN") : "—");

  return (
    <Card>
      <SectionTitle>Positioning &amp; vol</SectionTitle>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="PCR (OI)" value={ratio != null ? ratio.toFixed(2) : "—"} sub={pcrLabel} />
        <Stat label="ATM IV" value={o.atmIv != null ? `${(o.atmIv * 100).toFixed(1)}%` : "—"} sub={o.ivEstimated ? "estimated" : "live"} />
        <Stat label="Straddle" value={fmt(straddle)} sub="priced move" />
      </div>

      {hasOiChg(chain) && (
        <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-white/5">
          {(() => {
            const w = oiWritten(chain);
            return (
              <>
                <div>
                  <div className="text-[9px] uppercase tracking-wide text-white/35">Put OI today</div>
                  <div className={`text-lg font-bold tnum ${w.put >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{fmtOiSigned(w.put)}</div>
                  <div className="text-[9px] text-white/30">{w.put >= 0 ? "writing = support" : "unwinding"}</div>
                </div>
                <div>
                  <div className="text-[9px] uppercase tracking-wide text-white/35">Call OI today</div>
                  <div className={`text-lg font-bold tnum ${w.call >= 0 ? "text-rose-300" : "text-emerald-300"}`}>{fmtOiSigned(w.call)}</div>
                  <div className="text-[9px] text-white/30">{w.call >= 0 ? "writing = ceiling" : "unwinding"}</div>
                </div>
              </>
            );
          })()}
        </div>
      )}

      {lo != null && hi != null && (
        <div className="mt-3 pt-3 border-t border-white/5">
          <div className="flex justify-between text-[10px] text-white/40">
            <span>Expected move to expiry (±1σ)</span>
            <span className="tnum">±{fmt(em)}{emPct != null ? ` (${emPct.toFixed(1)}%)` : ""}</span>
          </div>
          <div className="relative h-6 mt-1 rounded bg-white/[0.05] overflow-hidden">
            <div className="absolute inset-y-0 left-[15%] right-[15%] bg-sky-500/20 border-x border-sky-400/40" />
            <div className="absolute inset-y-0 left-1/2 w-px bg-sky-300" />
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] tnum text-white/50">{fmt(lo)}</span>
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] tnum text-white/50">{fmt(hi)}</span>
          </div>
          <p className="text-[10px] text-white/40 mt-1.5 leading-snug">
            The market itself expects spot inside this band by expiry — strikes outside it are where sellers get paid to disagree.
          </p>
        </div>
      )}

      {skew != null && (
        <p className="text-[11px] mt-2">
          <span className="text-white/40">Skew: </span>
          <span className={skew >= 0 ? "text-rose-300" : "text-emerald-300"}>
            {skew >= 0 ? "puts bid — downside fear priced" : "calls bid — upside chase priced"} ({Math.abs(skew).toFixed(1)} vol pts)
          </span>
        </p>
      )}
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-white/35">{label}</div>
      <div className="text-xl font-bold tnum text-white/90">{value}</div>
      <div className="text-[9px] text-white/30">{sub}</div>
    </div>
  );
}
