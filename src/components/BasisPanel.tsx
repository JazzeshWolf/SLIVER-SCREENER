import type { ComponentChildren } from "preact";
import type { McxData } from "../lib/types";
import { Card, SectionTitle, Pill, Implication, fmtInt, pct } from "./ui";

export function BasisPanel({
  mcx,
  derived,
}: {
  mcx: McxData;
  derived: { fairValue: number | null; basis: number | null; premiumPct: number | null };
}) {
  const b = derived.basis;
  const fv = derived.fairValue;
  const fut = mcx.mcx.silverFut;
  const pp = derived.premiumPct;
  const dte = mcx.mcx.dte;

  const tone = b === null ? "neutral" : b >= 0 ? "bull" : "bear";

  // --- Basis implication ---
  let bTone: "bull" | "bear" | "neutral" | "warn" = "neutral";
  let bText = "Waiting on price + fair value.";
  if (pp != null) {
    if (pp > 0.5) {
      bTone = "bull";
      bText = `MCX trades ~${pp.toFixed(1)}% ABOVE landed-import fair value — a domestic PREMIUM. Local tightness (15% duty + import curbs) is making physical silver scarce, so buyers pay up. Supportive for MCX vs global; and for a short-call seller a rich premium that deflates into expiry is a tailwind.`;
    } else if (pp < -0.5) {
      bTone = "bear";
      bText = `MCX trades ~${Math.abs(pp).toFixed(1)}% BELOW fair value — a DISCOUNT. Weak local demand or ample supply; MCX may lag global silver. A soft local signal.`;
    } else {
      bTone = "neutral";
      bText = `MCX is trading right on import-parity fair value — cleanly tracking global silver with no domestic premium or discount distorting the price.`;
    }
  }

  // --- Convergence implication ---
  let cText = "Expiry data unavailable.";
  let cTone: "bull" | "bear" | "neutral" | "warn" = "neutral";
  if (dte != null && pp != null) {
    if (dte <= 5) {
      cTone = "warn";
      cText = `Only ${dte} days to expiry. The ${pct(pp)} gap should be collapsing toward the structural duty/GST premium now. If it's still wide, watch for a last-minute squeeze near busy strikes — risk if you're short, edge if you're positioned for it.`;
    } else {
      cText = `~${dte} days left. The ₹${fmtInt(b)} (${pct(pp)}) gap should narrow smoothly toward the local premium as expiry nears. Smooth narrowing = orderly market. Sudden widening = physical stress/squeeze — the early-warning sign for short calls.`;
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle>Fair value vs MCX futures</SectionTitle>
        <div className="grid grid-cols-2 gap-3">
          <Metric label="MCX futures" value={`₹${fmtInt(fut)}`} />
          <Metric label="Theoretical FV" value={`₹${fmtInt(fv)}`} />
          <Metric label="Basis (fut − FV)" value={`₹${fmtInt(b)}`} pill={<Pill tone={tone}>{pct(pp)}</Pill>} />
          <Metric label="Future DTE" value={`${dte ?? "—"}`} />
        </div>
        <Implication tone={bTone}>{bText}</Implication>
        <p className="text-[10px] text-white/30 mt-2">
          FV = spot × 32.1507 × USD-INR × (1 + 15% duty + 3% GST). Basis = how far MCX sits above/below
          that landed-import cost.
        </p>
      </Card>

      <Card>
        <SectionTitle>Convergence into expiry</SectionTitle>
        <Implication tone={cTone} label="What to watch">{cText}</Implication>
      </Card>
    </div>
  );
}

function Metric({ label, value, pill }: { label: string; value: string; pill?: ComponentChildren }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-white/40">{label}</div>
      <div className="text-base font-semibold tnum mt-0.5 flex items-center gap-2">
        {value} {pill}
      </div>
    </div>
  );
}
