import type { McxData } from "../lib/types";
import { topByOi, fmtOi } from "../lib/chain";
import { Card, SectionTitle } from "./ui";

export function KeyLevels({ mcx }: { mcx: McxData }) {
  const chain = mcx.options.chain ?? [];
  const gex = mcx.gex;
  const spot = mcx.mcx.fut;
  if (!chain.length) return null;

  const supports = topByOi(chain, "PE", 3);
  const resistances = topByOi(chain, "CE", 3);
  const maxPain = gex?.maxPain ?? null;
  const mpAway = maxPain != null && spot ? ((maxPain - spot) / spot) * 100 : null;
  const fmt = (n: number | null | undefined) => (n != null ? Math.round(n).toLocaleString("en-IN") : "—");

  return (
    <Card>
      <SectionTitle>Key levels (OI)</SectionTitle>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-lg font-bold text-emerald-300 tnum">{fmt(gex?.putWall)}</div>
          <div className="text-[9px] uppercase tracking-wide text-white/35">Put wall</div>
          <div className="text-[9px] text-white/30">support magnet</div>
        </div>
        <div>
          <div className="text-lg font-bold text-amber-300 tnum">{fmt(maxPain)}</div>
          <div className="text-[9px] uppercase tracking-wide text-white/35">Max pain</div>
          <div className="text-[9px] text-white/30">{mpAway != null ? `${Math.abs(mpAway).toFixed(1)}% ${mpAway >= 0 ? "up" : "down"}` : "—"}</div>
        </div>
        <div>
          <div className="text-lg font-bold text-rose-300 tnum">{fmt(gex?.callWall)}</div>
          <div className="text-[9px] uppercase tracking-wide text-white/35">Call wall</div>
          <div className="text-[9px] text-white/30">resistance magnet</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mt-3 pt-3 border-t border-white/5">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-emerald-300/70 mb-1">Supports (put OI)</div>
          {supports.map((s) => (
            <div key={s.strike} className="flex justify-between text-xs text-white/60">
              <span className="tnum">{fmt(s.strike)}</span>
              <span className="tnum text-white/40">{fmtOi(s.oi)}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-rose-300/70 mb-1">Resistances (call OI)</div>
          {resistances.map((s) => (
            <div key={s.strike} className="flex justify-between text-xs text-white/60">
              <span className="tnum">{fmt(s.strike)}</span>
              <span className="tnum text-white/40">{fmtOi(s.oi)}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
