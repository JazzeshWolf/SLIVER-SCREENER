// Type surface for the metal registry (metals.mjs). The registry itself is
// plain ESM so scripts/build-data.mjs can import it without a build step; these
// declarations are what the strict-TS client sees.

/** How confident we are that this metal's import-parity formula is right. */
export type ParityConfidence = "verified" | "approximate";

/** One tradeable contract within a metal family (e.g. SILVERM inside silver). */
export interface MetalContract {
  symbol: string;
  label: string;
  /**
   * ₹ quote units in one lot — the multiplier from a quoted premium to ₹/lot.
   * NOT the lot size: GOLDM is a 100 g lot quoted in ₹/10 g, so this is 10.
   */
  quoteUnitsPerLot: number;
}

export interface MetalIntlFeeds {
  /** gold-api.com symbol; null when no free CORS spot API exists (copper). */
  goldApi: string | null;
  /** Twelve Data symbol aliases, tried in order. */
  td: string[];
  yahoo: string | null;
  stooq: string | null;
}

/** COMEX reference contract, for the term-structure ladder. */
export interface MetalComex {
  root: string; // e.g. "SI"
  spot: string; // Yahoo continuous symbol, e.g. "SI=F"
  /** monthIndex (0-11) -> delivery month code, for the liquid months only. */
  months: Record<number, string>;
}

/** Per-metal news queries and the direct/indirect classification patterns. */
export interface MetalNews {
  query: string;
  forecastQuery: string;
  trustedSubject: string;
  indirectQuery: string;
  /** RegExp source: headline is ABOUT this metal. */
  directPattern: string;
  /** RegExp source: headline is about a DRIVER of this metal. */
  indirectPattern: string;
}

export interface MetalConfig {
  id: string;
  label: string;
  emoji: string;
  /** Base commodity name (SILVER/GOLD/COPPER) — resolves unlisted family members. */
  family: string;
  /** The MCX symbol the data pipeline pulls (must match a `contracts` entry). */
  feedSymbol: string;
  contracts: MetalContract[];
  /** Display unit for prices/premiums, e.g. "₹/kg" or "₹/10g". */
  quoteUnit: string;
  /** Noun for one quote unit, e.g. "kg" or "10g". */
  lotNoun: string;

  /** Unit of the international reference price, e.g. "$/oz" or "$/lb". */
  intlUnit: string;
  /** intl → ₹ quote-unit conversion, before FX and levies. */
  unitMult: number;
  /** Basic customs duty as a fraction. */
  duty: number;
  /** GST as a fraction. */
  gst: number;
  parityConfidence: ParityConfidence;

  comex: MetalComex;
  news: MetalNews;
  intlFeeds: MetalIntlFeeds;
  /** CFTC contract market code for the COT report. */
  cotCode: string;
  /** Strike step used only when the live chain is too thin to derive one. */
  strikeStepFallback: number;
}

export declare const METALS: Record<string, MetalConfig>;
export declare const METAL_IDS: string[];
export declare function allContractSymbols(): string[];
export declare const DEFAULT_METAL: string;

export declare function metalFor(id: string | null | undefined): MetalConfig;
export declare function metalForSymbol(symbol: string | null | undefined): MetalConfig;
export declare function parityMult(metal: MetalConfig): number;
export declare function quoteUnitsPerLot(
  metal: MetalConfig,
  symbol: string | null | undefined,
): number;
export declare function strikeStep(
  metal: MetalConfig,
  chain: { strike: number }[] | null | undefined,
): number;
