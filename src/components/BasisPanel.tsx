import type { ComponentChildren } from "preact";
import type { McxData } from "../lib/types";
import { Card, SectionTitle, Pill, fmtInt, pct } from "./ui";

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

  const tone = b === null ? "neutral" : b >= 0 ? "bull" : "bear";
  const backwardation = b !== null && b < 0;

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle>Fair value vs MCX futures</SectionTitle>
        <div className="grid grid-cols-2 gap-3">
          <Metric label="MCX futures" value={`₹${fmtInt(fut)}`} />
          <Metric label="Theoretical FV" value={`₹${fmtInt(fv)}`} />
          <Metric label="Basis (fut − FV)" value={`₹${fmtInt(b)}`} pill={<Pill tone={tone}>{pct(pp)}</Pill>} />
          <Metric label="DTE to expiry" value={`${mcx.mcx.dte ?? "—"}`} />
        </div>
        <p className="text-xs text-white/40 mt-2">
          FV = spot × 32.1507 × USD-INR × (1 + duty + GST). Basis captures local premium + cost of
          carry. As expiry nears it should converge toward the duty/GST-driven local premium.
        </p>
        {backwardation && (
          <div className="mt-2 text-xs text-rose-300/90">
            ⚠ Futures below fair value (backwardation/discount) — possible local tightness or stress;
            relevant if you're short calls.
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>Convergence into expiry</SectionTitle>
        <p className="text-sm text-white/60">
          {mcx.mcx.dte === null
            ? "Expiry data unavailable."
            : mcx.mcx.dte <= 5
              ? "Inside the roll window — basis should be near the local premium; watch for last-minute squeezes."
              : `~${mcx.mcx.dte} days to expiry. Track the basis daily; smooth narrowing = healthy convergence, sudden widening = stress.`}
        </p>
      </Card>
    </div>
  );
}

function Metric({
  label,
  value,
  pill,
}: {
  label: string;
  value: string;
  pill?: ComponentChildren;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase text-white/40">{label}</div>
      <div className="text-base font-semibold tnum mt-0.5 flex items-center gap-2">
        {value} {pill}
      </div>
    </div>
  );
}
