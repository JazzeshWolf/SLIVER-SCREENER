// ---------------------------------------------------------------------------
// THE METAL REGISTRY — one source of truth for every per-metal constant.
//
// Written as .mjs (with a companion metals.d.ts) because it has two consumers
// with different runtimes: the browser client (strict TS, bundled by Vite) and
// scripts/build-data.mjs (plain Node ESM, no build step). Duplicating these
// constants across the two is exactly the bug that already existed — the parity
// numbers lived in BOTH src/lib/basis.ts and scripts/build-data.mjs and had to
// be kept in sync by hand.
//
// PARITY. Every metal's import-parity fair value collapses to one formula:
//
//     FV = intlPrice × unitMult × usdInr × (1 + duty + gst)
//
// with only the constant changing. That is why this file is pure data — no
// per-metal functions, no switch statements downstream.
//
//     silver: $/oz × 32.1507   → ₹/kg    (troy oz per kg)
//     gold:   $/oz × 0.3215069 → ₹/10g   (= 10 g ÷ 31.1035 g/oz)
//     copper: $/lb × 2.20462   → ₹/kg    (lb per kg) — see parityConfidence
//
// UNITS. `quoteUnitsPerLot` is deliberately NOT called "lot size". MCX quotes
// gold in ₹ per 10 g but sells it in 100 g lots, so ₹/lot = premium × 10, not
// × 100. Naming the field after the quote unit makes the 10× error hard to
// write. Every ₹-per-lot number in the app (credit, margin, P&L) goes through
// this one field.
// ---------------------------------------------------------------------------

/** Grams in one troy ounce — the exact figure behind every bullion unit. */
const GRAMS_PER_TROY_OZ = 31.1035;

/** @type {Record<string, import("./metals").MetalConfig>} */
export const METALS = {
  silver: {
    id: "silver",
    label: "Silver",
    emoji: "🥈",
    family: "SILVER",
    // The contract the data pipeline actually pulls. The mini is the default
    // because it is what a retail premium seller trades; the big contract's
    // chain is deeper but its lot is 6× the margin.
    feedSymbol: "SILVERM",
    contracts: [
      { symbol: "SILVER", label: "SILVER (30 kg)", quoteUnitsPerLot: 30 },
      { symbol: "SILVERM", label: "SILVERM (5 kg)", quoteUnitsPerLot: 5 },
      { symbol: "SILVERMIC", label: "SILVERMIC (1 kg)", quoteUnitsPerLot: 1 },
    ],
    quoteUnit: "₹/kg",
    lotNoun: "kg",

    // --- import parity -----------------------------------------------------
    intlUnit: "$/oz",
    // Troy oz per kg. Frozen as this literal (not 1000/GRAMS_PER_TROY_OZ,
    // which is 32.150746) because AUDIT.md G1 hand-verified silver's fair
    // value to the rupee against it — changing it would move a live number.
    unitMult: 32.1507,
    // Effective Indian import levies. These step-change with duty
    // notifications: duty was hiked to 15% on 2026-05-13 (silver moved to the
    // DGFT "Restricted" category), on top of 3% GST.
    duty: 0.15,
    gst: 0.03,
    // Hand-verified to the rupee against the live snapshot (see AUDIT.md G1).
    parityConfidence: "verified",

    // --- feeds -------------------------------------------------------------
    intlFeeds: {
      goldApi: "XAG", // also the browser-side live overlay (CORS-enabled)
      td: ["XAG/USD", "XAGUSD", "SILVER", "XAG"],
      yahoo: "SI=F",
      stooq: "xagusd",
    },
    cotCode: "084691", // CFTC — SILVER, COMMODITY EXCHANGE INC.

    // Fallback only. The real step is derived from the median gap between
    // listed strikes on the live chain, because MCX changes it (gold's option
    // strike interval went ₹100 → ₹500 on 2026-01-30).
    strikeStepFallback: 1000,
  },

  gold: {
    id: "gold",
    label: "Gold",
    emoji: "🥇",
    family: "GOLD",
    feedSymbol: "GOLDM",
    contracts: [
      // 100 g lot quoted in ₹/10 g → 10 quote units per lot, NOT 100.
      { symbol: "GOLDM", label: "GOLDM (100 g)", quoteUnitsPerLot: 10 },
    ],
    quoteUnit: "₹/10g",
    lotNoun: "10g",

    intlUnit: "$/oz",
    // $/oz → ₹/10g. Written as the exact quotient rather than a rounded
    // decimal: 0.321507 is off by ~7e-7, which is ₹0.11 on a ₹1.5 lakh quote.
    unitMult: 10 / GRAMS_PER_TROY_OZ,
    duty: 0.15, // same bullion regime as silver since 2026-05-13
    gst: 0.03,
    parityConfidence: "verified",

    intlFeeds: {
      goldApi: "XAU",
      td: ["XAU/USD"],
      yahoo: "GC=F",
      stooq: "xauusd",
    },
    cotCode: "088691", // CFTC — GOLD, COMMODITY EXCHANGE INC.

    strikeStepFallback: 500, // MCX widened gold's interval ₹100 → ₹500 (2026-01-30)
  },

  copper: {
    id: "copper",
    label: "Copper",
    emoji: "🟠",
    family: "COPPER",
    feedSymbol: "COPPER",
    contracts: [{ symbol: "COPPER", label: "COPPER (2500 kg)", quoteUnitsPerLot: 2500 }],
    quoteUnit: "₹/kg",
    lotNoun: "kg",

    // PARITY CAVEAT — read before trusting a copper basis number.
    // MCX copper tracks LME, but the only free daily copper price feed is
    // COMEX HG ($/lb). Through the US Section 232 tariff regime COMEX has run
    // ~$500–600/t ABOVE LME, so a COMEX-anchored parity is biased high by a
    // policy spread that has nothing to do with Indian import economics.
    // Hence parityConfidence:"approximate" — the UI must flag or suppress the
    // copper basis rather than present it as a clean import-parity read.
    // Switching to LME cash ($/t) means unitMult 0.001 and nothing else.
    intlUnit: "$/lb",
    unitMult: 2.20462, // lb per kg
    // Base-metal levies, NOT the bullion regime: refined copper carries BCD,
    // not the 10% BCD + 5% AIDC that gold and silver do.
    duty: 0.05,
    gst: 0.18,
    parityConfidence: "approximate",

    intlFeeds: {
      goldApi: null, // no free CORS spot API → copper has no browser live overlay
      td: [],
      yahoo: "HG=F",
      stooq: "hg.f",
    },
    cotCode: "085692", // CFTC — COPPER- #1, COMMODITY EXCHANGE INC.

    strikeStepFallback: 5, // ₹/kg; tick is ₹0.05
  },
};

/** Metal ids in the order the picker shows them. */
export const METAL_IDS = ["silver", "gold", "copper"];

/**
 * Every contract symbol the registry knows, across all metals. Passed to the
 * instrument matcher as the "siblings" set so a longer relative (SILVERMIC vs
 * SILVERM, GOLDM vs GOLD) can never leak into another contract's chain.
 */
export function allContractSymbols() {
  return METAL_IDS.flatMap((id) => METALS[id].contracts.map((c) => c.symbol));
}

/** The metal the app opens on when nothing is persisted. */
export const DEFAULT_METAL = "silver";

/** Look up a metal, falling back to the default rather than throwing. */
export function metalFor(id) {
  return METALS[String(id ?? "").toLowerCase()] ?? METALS[DEFAULT_METAL];
}

/**
 * Which metal owns an MCX contract symbol (SILVERM → silver, GOLDM → gold).
 * Matched against the registry's declared contracts by EXACT symbol, then by
 * longest-prefix — never a bare `startsWith`, which is what let "GOLD" swallow
 * GOLDM/GOLDPETAL and mix contracts of different lot sizes into one chain.
 */
export function metalForSymbol(symbol) {
  const s = String(symbol ?? "").toUpperCase();
  if (!s) return METALS[DEFAULT_METAL];
  for (const id of METAL_IDS) {
    if (METALS[id].contracts.some((c) => c.symbol === s)) return METALS[id];
  }
  // A family member we do not list (GOLDPETAL, GOLDGUINEA): resolve by the
  // base commodity name. Longest family wins so nothing is ambiguous. This
  // matters because the old normalizeSymbol() sent every unrecognized symbol
  // to SILVER's 30 kg lot — a gold leg would have been mispriced 3×.
  let best = null;
  let bestLen = 0;
  for (const id of METAL_IDS) {
    const fam = METALS[id].family;
    if (s.startsWith(fam) && fam.length > bestLen) {
      best = METALS[id];
      bestLen = fam.length;
    }
  }
  return best ?? METALS[DEFAULT_METAL];
}

/**
 * The single parity multiplier: ₹ per quote unit, per unit of international
 * price. Kept here so the client and the builder can never disagree about it.
 */
export function parityMult(metal) {
  return metal.unitMult * (1 + metal.duty + metal.gst);
}

/**
 * ₹ quote units in one lot of `symbol` (e.g. SILVERM → 5, GOLDM → 10).
 * Falls back to the metal's default contract for an unknown symbol rather than
 * silently picking the biggest lot — the old normalizeSymbol() defaulted any
 * unrecognized symbol to SILVER's 30 kg, which would misprice a GOLDM leg 3×.
 */
export function quoteUnitsPerLot(metal, symbol) {
  const s = String(symbol ?? "").toUpperCase();
  const exact = metal.contracts.find((c) => c.symbol === s);
  if (exact) return exact.quoteUnitsPerLot;
  const def = metal.contracts.find((c) => c.symbol === metal.feedSymbol);
  return (def ?? metal.contracts[0]).quoteUnitsPerLot;
}

/**
 * Derive the chain's strike step from the listed strikes — the exchange changes
 * these (gold went ₹100 → ₹500 in Jan 2026), so the registry value is only a
 * fallback for an empty/1-strike chain. Uses the MEDIAN gap so a single missing
 * strike or a stray far-OTM listing can't skew it.
 */
export function strikeStep(metal, chain) {
  const strikes = [...new Set((chain ?? []).map((o) => o.strike).filter((s) => s > 0))].sort(
    (a, b) => a - b,
  );
  if (strikes.length < 3) return metal.strikeStepFallback;
  const gaps = [];
  for (let i = 1; i < strikes.length; i++) {
    const g = strikes[i] - strikes[i - 1];
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return metal.strikeStepFallback;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
