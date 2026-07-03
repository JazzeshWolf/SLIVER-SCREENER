import type { GexData } from "../lib/types";
import { Card, SectionTitle, Pill, Implication, fmtInt } from "./ui";

const REGIME_META = {
  pinning: {
    tone: "bull" as const,
    label: "PINNING",
    text: (g: GexData, F: number | null) =>
      `Dealers lean LONG gamma — their hedging dampens moves, so price tends to get pulled toward the big-OI strikes and stay there. Good for premium sellers: decay wins while price pins${
        F != null && g.pinStrike != null ? ` (pin magnet ≈ ${fmtInt(g.pinStrike)}, ${fmtInt(Math.abs(F - g.pinStrike))} away)` : ""
      }.`,
  },
  balanced: {
    tone: "neutral" as const,
    label: "BALANCED",
    text: () =>
      "Gamma is roughly balanced between calls and puts — no strong pin or amplification force. Price follows the macro; lean on the direction gauges.",
  },
  volatile: {
    tone: "warn" as const,
    label: "VOLATILE",
    text: () =>
      "Dealers lean SHORT gamma — their hedging AMPLIFIES moves (they buy rallies, sell dips). Breakouts run further than usual. Size short options smaller and keep strikes wider.",
  },
};

export function GexCard({ gex, fut }: { gex: GexData | null | undefined; fut: number | null }) {
  if (!gex) {
    return (
      <Card>
        <SectionTitle>Gamma exposure (GEX)</SectionTitle>
        <p className="text-sm text-white/40">
          Needs live option OI — populates during market hours once the chain is quoted.
        </p>
      </Card>
    );
  }
  const meta = REGIME_META[gex.regime];
  // Net gauge: -100 (short gamma) .. +100 (long gamma).
  const pct = Math.max(-100, Math.min(100, gex.netPct));
  const barLeft = pct >= 0 ? 50 : 50 + pct / 2;
  const barWidth = Math.abs(pct) / 2;

  return (
    <Card>
      <div className="flex items-center justify-between">
        <SectionTitle>Gamma exposure (GEX)</SectionTitle>
        <Pill tone={meta.tone}>{meta.label}</Pill>
      </div>

      <div className="relative h-2 rounded-full bg-white/10 mt-1">
        <div className="absolute left-1/2 top-0 h-full w-px bg-white/30" />
        <div
          className={`absolute top-0 h-full rounded-full ${pct >= 0 ? "bg-emerald-400" : "bg-rose-400"}`}
          style={{ left: `${barLeft}%`, width: `${barWidth}%` }}
        />
      </div>
      <div className="flex justify-between text-[9px] text-white/30 mt-1">
        <span>short gamma · moves amplify</span>
        <span className="tnum text-white/50">{gex.netPct > 0 ? "+" : ""}{gex.netPct}</span>
        <span>long gamma · moves dampen</span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-3 text-xs">
        <KV label="Pin magnet" v={gex.pinStrike} />
        <KV label="Max pain" v={gex.maxPain} />
        <KV label="Call wall (resistance)" v={gex.callWall} />
        <KV label="Put wall (support)" v={gex.putWall} />
      </div>

      <Implication tone={meta.tone}>{meta.text(gex, fut)}</Implication>

      <p className="text-[10px] text-white/30 mt-2">
        Experimental: Black-76 gamma × OI over {gex.coverage} quoted options; assumes dealers are net
        long calls / short puts. MCX OI is thin — treat as a lean, not gospel.
      </p>
    </Card>
  );
}

function KV({ label, v }: { label: string; v: number | null }) {
  return (
    <div className="flex justify-between">
      <span className="text-white/45">{label}</span>
      <span className="tnum text-white/85 font-medium">{v == null ? "—" : fmtInt(v)}</span>
    </div>
  );
}
