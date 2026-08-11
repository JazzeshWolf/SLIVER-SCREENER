import { useEffect, useState } from "preact/hooks";
import type { MetalSummary } from "../lib/types";
import { fetchMetalIndex } from "../lib/fetchers";
import { METAL_IDS, METALS } from "../lib/metals.mjs";
import { fmtInt } from "./ui";

/**
 * The entry screen: pick Silver, Gold or Copper.
 *
 * Each card carries a live summary rather than just a name, because the first
 * question a premium seller asks is "which of these is worth looking at today?"
 * — and IV rank plus VRP answers that before you open anything. Cards render
 * from the small index.json, so this screen never waits on a full chain.
 */
export function MetalPicker({ onSelect }: { onSelect: (id: string) => void }) {
  const [rows, setRows] = useState<MetalSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchMetalIndex()
      .then((r) => alive && (r ? setRows(r) : setFailed(true)))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  // Always offer every registered metal, even if the index hasn't loaded — the
  // picker must never become a dead end because a data file is missing.
  const cards = METAL_IDS.map((id) => {
    const m = METALS[id];
    return { meta: m, summary: rows?.find((r) => r.id === id) ?? null };
  });

  return (
    <div className="flex flex-col min-h-[100dvh] px-4 pt-10 pb-8">
      <h1 className="text-2xl font-bold tracking-tight">Metals Screener</h1>
      <p className="text-sm text-white/45 mt-1">
        MCX options — pick a metal to see its direction, chain and sell candidates.
      </p>

      <div className="mt-6 space-y-3">
        {cards.map(({ meta, summary }) => (
          <MetalCard key={meta.id} meta={meta} s={summary} onSelect={() => onSelect(meta.id)} />
        ))}
      </div>

      {failed && !rows && (
        <p className="text-[11px] text-amber-300/70 mt-4">
          Couldn't load the live summary — the cards below still work, they just open without a preview.
        </p>
      )}

      <p className="text-[10px] leading-relaxed text-white/30 mt-auto pt-8">
        A decision aid, not a signal. Factor weights are hand-set priors, not backtested — trust the
        regime and the gates, not the decimal.
      </p>
    </div>
  );
}

function MetalCard({
  meta,
  s,
  onSelect,
}: {
  meta: { id: string; label: string; emoji: string; quoteUnit: string };
  s: MetalSummary | null;
  onSelect: () => void;
}) {
  const chg = s?.changePct ?? null;
  const chgTone = chg == null ? "text-white/30" : chg > 0 ? "text-emerald-300" : chg < 0 ? "text-rose-300" : "text-white/50";

  // VRP is the honest one-glance read of whether there is premium to sell —
  // but only when IV is a traded price. On a proxy it is mechanically positive
  // and says nothing, so it is shown as "—" rather than as false encouragement.
  const proxy = s?.ivEstimated !== false;
  const vrp = proxy ? null : (s?.vrp ?? null);

  return (
    <button
      onClick={onSelect}
      className="w-full text-left rounded-2xl bg-white/[0.04] border border-white/10 px-4 py-3.5 active:bg-white/[0.08] transition-colors"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2.5">
          <span className="text-2xl leading-none">{meta.emoji}</span>
          <span>
            <span className="block text-base font-semibold text-white/90">{meta.label}</span>
            <span className="block text-[10px] uppercase tracking-wide text-white/35">
              {s?.symbol ?? meta.id} · {meta.quoteUnit}
            </span>
          </span>
        </span>
        <span className="text-right">
          <span className="block text-lg font-semibold tnum text-white/90">
            {s?.fut != null ? `₹${fmtInt(s.fut)}` : "—"}
          </span>
          <span className={`block text-[11px] tnum ${chgTone}`}>
            {chg == null ? "" : `${chg > 0 ? "+" : ""}${chg.toFixed(2)}%`}
          </span>
        </span>
      </div>

      <div className="flex items-center gap-3 mt-2.5 text-[10px] text-white/40">
        <Stat label="IV rank" value={s?.ivRank != null ? s.ivRank.toFixed(0) : "—"} />
        <Stat
          label="VRP"
          value={vrp == null ? "—" : `${vrp > 0 ? "+" : ""}${vrp.toFixed(1)}`}
          tone={vrp == null ? undefined : vrp < 0 ? "bad" : vrp >= 2 ? "good" : "warn"}
        />
        <Stat label="DTE" value={s?.optionDte != null ? String(s.optionDte) : "—"} />
        <Stat label="Chain" value={s?.chainLegs ? String(s.chainLegs) : "—"} />
        <span className="ml-auto">{healthPill(s)}</span>
      </div>
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  const c = tone === "bad" ? "text-rose-300" : tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-white/70";
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-white/30">{label}</span>
      <span className={`tnum ${c}`}>{value}</span>
    </span>
  );
}

/** One honest word about whether this metal's data is real right now. */
function healthPill(s: MetalSummary | null) {
  const pill = (text: string, cls: string) => (
    <span className={`text-[9px] uppercase tracking-wide border rounded px-1 py-0.5 ${cls}`}>{text}</span>
  );
  if (!s || !s.ok) return pill("no data", "text-white/30 border-white/15");
  if (s.stale) return pill("stale", "text-amber-300/80 border-amber-400/30");
  if (s.estimated) return pill("est.", "text-amber-300/80 border-amber-400/30");
  if (!s.chainLegs) return pill("no chain", "text-amber-300/80 border-amber-400/30");
  if (s.ivEstimated) return pill("proxy IV", "text-amber-300/80 border-amber-400/30");
  return pill("live", "text-emerald-300/80 border-emerald-400/30");
}
