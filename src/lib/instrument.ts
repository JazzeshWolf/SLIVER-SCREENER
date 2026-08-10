// ---------------------------------------------------------------------------
// MCX silver contract specs. One source of truth for lot size, so the position
// tracker and the sell screener always agree on what "one lot" means.
// ---------------------------------------------------------------------------

export type SilverSymbol = "SILVER" | "SILVERM" | "SILVERMIC";

/** Contract size in kg. Premiums and futures are quoted in ₹/kg on MCX. */
export const LOT_KG: Record<SilverSymbol, number> = {
  SILVER: 30,
  SILVERM: 5,
  SILVERMIC: 1,
};

export const SYMBOL_LABELS: { symbol: SilverSymbol; label: string }[] = [
  { symbol: "SILVER", label: "SILVER (30 kg)" },
  { symbol: "SILVERM", label: "SILVERM (5 kg)" },
  { symbol: "SILVERMIC", label: "SILVERMIC (1 kg)" },
];

/** Normalize whatever the feed calls the contract into a known symbol. */
export function normalizeSymbol(symbol: string | null | undefined): SilverSymbol {
  const s = (symbol ?? "").toUpperCase();
  if (s.includes("MIC")) return "SILVERMIC";
  if (s.includes("SILVERM") || s.endsWith("M")) return "SILVERM";
  return "SILVER";
}

/** Lot size in kg for the feed's symbol, defaulting to the mini contract. */
export function lotKgFor(symbol: string | null | undefined): number {
  return LOT_KG[normalizeSymbol(symbol)];
}
