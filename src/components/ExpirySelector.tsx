import type { ExpiryBundle } from "../lib/types";

function fmtExpiry(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * Monthly-expiry picker. Switching re-points every option card (chain, IV rank,
 * expected-move cone, GEX, theta, premium-sell, market structure) to the chosen
 * contract via the store's mcx view. Hidden when there's only one expiry.
 */
export function ExpirySelector({
  expiries,
  selected,
  onSelect,
}: {
  expiries: ExpiryBundle[];
  selected: string | null;
  onSelect: (optionExpiry: string) => void;
}) {
  if (!expiries || expiries.length < 2) return null;
  const active = selected ?? expiries[0].optionExpiry;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 no-scrollbar">
      <span className="text-[10px] uppercase tracking-wider text-white/30 shrink-0 mr-0.5">Expiry</span>
      {expiries.map((e) => {
        const on = e.optionExpiry === active;
        const thin = !e.chain || e.chain.length < 4; // far/illiquid month
        return (
          <button
            key={e.optionExpiry}
            onClick={() => onSelect(e.optionExpiry)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
              on
                ? "bg-sky-500/20 text-sky-200 border-sky-400/40"
                : "bg-white/5 text-white/55 border-white/10 hover:text-white/80"
            }`}
          >
            {fmtExpiry(e.optionExpiry)}
            <span className="text-[10px] opacity-60"> · {e.optionDte}d</span>
            {thin && <span className="text-[9px] text-amber-300/70"> · thin</span>}
          </button>
        );
      })}
    </div>
  );
}
