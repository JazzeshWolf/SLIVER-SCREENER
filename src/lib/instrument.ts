// ---------------------------------------------------------------------------
// Contract specs, resolved through the metal registry (metals.mjs). One source
// of truth for how a quoted premium becomes ₹ per lot, so the position tracker
// and the sell screener can never disagree about what "one lot" means.
//
// Everything here is a thin, typed wrapper over the registry — the constants
// themselves live in metals.mjs because scripts/build-data.mjs needs them too.
// ---------------------------------------------------------------------------

import { metalFor, metalForSymbol, quoteUnitsPerLot } from "./metals.mjs";
import type { MetalConfig, MetalContract } from "./metals.mjs";

export { metalFor, metalForSymbol };
export type { MetalConfig, MetalContract };

/** The contracts a metal lists, for the lot-size dropdowns. */
export function contractsFor(metal: MetalConfig): MetalContract[] {
  return metal.contracts;
}

/**
 * ₹ quote units in one lot — the multiplier from a quoted premium to ₹/lot.
 *
 * Deliberately NOT called "lot size in kg": MCX quotes gold in ₹ per 10 g but
 * sells it in 100 g lots, so this returns 10 for GOLDM, not 100. Every ₹/lot
 * figure in the app (credit, margin, position P&L) routes through here.
 */
export function lotUnitsFor(metal: MetalConfig, symbol: string | null | undefined): number {
  return quoteUnitsPerLot(metal, symbol);
}

/** Lot units for a bare MCX symbol, resolving its metal first. */
export function lotUnitsForSymbol(symbol: string | null | undefined): number {
  return quoteUnitsPerLot(metalForSymbol(symbol), symbol);
}
