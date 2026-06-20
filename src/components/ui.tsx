import type { ComponentChildren } from "preact";

export function Card({
  children,
  className = "",
}: {
  children: ComponentChildren;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl bg-[#11161f] border border-white/5 p-4 ${className}`}>
      {children}
    </div>
  );
}

export function SectionTitle({ children }: { children: ComponentChildren }) {
  return (
    <h2 className="text-xs uppercase tracking-wider text-white/40 font-semibold mb-2 mt-1">
      {children}
    </h2>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ComponentChildren;
  tone?: "bull" | "bear" | "neutral" | "warn";
}) {
  const tones: Record<string, string> = {
    bull: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    bear: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    neutral: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** Highlighted "what this means for silver" explainer block. */
export function Implication({
  children,
  tone = "neutral",
  label = "What it means",
}: {
  children: ComponentChildren;
  tone?: "bull" | "bear" | "neutral" | "warn";
  label?: string;
}) {
  const border: Record<string, string> = {
    bull: "border-emerald-400/60",
    bear: "border-rose-400/60",
    neutral: "border-sky-400/60",
    warn: "border-amber-400/60",
  };
  const lab: Record<string, string> = {
    bull: "text-emerald-300",
    bear: "text-rose-300",
    neutral: "text-sky-300",
    warn: "text-amber-300",
  };
  return (
    <div className={`mt-2 rounded-lg bg-white/[0.04] border-l-2 ${border[tone]} px-2.5 py-2 text-xs leading-snug text-white/75`}>
      <span className={`font-semibold ${lab[tone]}`}>{label} · </span>
      {children}
    </div>
  );
}

// --- formatting helpers ----------------------------------------------------

export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-IN");
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const s = n > 0 ? "+" : "";
  return `${s}${n.toFixed(digits)}%`;
}

export function arrow(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return "→";
  return n > 0 ? "▲" : "▼";
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}
