// Type surface for the metal registry (metals.mjs). The registry itself is
// plain ESM so scripts/build-data.mjs can import it without a build step; these
// declarations are what the strict-TS client sees.

/** How confident we are that this metal's import-parity formula is right. */
export type ParityConfidence = "verified" | "approximate";

/**
 * What the parity formula IS. "import": the landed cost of importing the metal
 * (duty + GST), so a gap to MCX is a real domestic premium or discount.
 * "settlement": the exchange's own settlement rule (MCX crude settles on NYMEX
 * WTI × the RBI rate), so a gap is only feed timing and says nothing.
 */
export type ParityKind = "import" | "settlement";

/** Broad asset class — decides which cross-asset panels mean anything. */
export type Sector = "bullion" | "base" | "energy";

/**
 * Where the futures-curve card and the term-structure factor get their curve.
 * "intl": the international exchange's listed months via Yahoo (COMEX).
 * "mcx": the MCX futures strip the pipeline already fetches.
 */
export type CurveFrom = "intl" | "mcx";

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
  /** gold-api.com symbol; null when no free CORS spot API exists (copper, crude). */
  goldApi: string | null;
  /** Twelve Data symbol aliases, tried in order. */
  td: string[];
  yahoo: string | null;
  stooq: string | null;
}

/** International reference contract (COMEX, or NYMEX for crude). */
export interface MetalComex {
  /** Exchange name for display ("COMEX", "NYMEX"). */
  exchange: string;
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

/** Per-metal direction-engine configuration. */
export interface MetalEngine {
  /** Constant structural prior in [-1,1], applied on 1W/1M only. */
  structuralBias: number;
  structuralLabel: string;
  structuralNote: string;
  /**
   * The non-price factors that count as this metal's macro pillar. When they
   * are missing, confidence is capped so the score can't ride on momentum
   * alone. Dollar + real yields for bullion; the growth proxy or the curve
   * where real yields mean nothing.
   */
  macroKeys: string[];
  /** factorKey -> per-horizon weight. Each horizon column must sum to 1. */
  weights: Record<string, Record<string, number>>;
}

/** Sell-screener calibration. Silver's numbers are the app's originals. */
export interface MetalScreen {
  /** Below this OI a single leg is untradeable. */
  minOi: number;
  /** Real but shallow — surfaced with a THIN warning. */
  thinOi: number;
  /** Total chain OI below which the screener refuses to rank at all (0 = off). */
  minChainOi: number;
  /** Annualized return-on-margin that normalizes to a full sub-score. */
  romDivisor: number;
  /** SPAN-like margin scan grid. */
  priceScan: number;
  volScan: number;
}

export interface MetalConfig {
  id: string;
  label: string;
  emoji: string;
  /** Base commodity name (SILVER/GOLD/COPPER/CRUDEOIL) — resolves unlisted family members. */
  family: string;
  sector: Sector;
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
  parityKind: ParityKind;
  /** Realized-vol multiple of gold; seeds a flagged IV proxy on thin history. */
  volBetaToGold: number;
  curveFrom: CurveFrom;

  screen: MetalScreen;
  engine: MetalEngine;
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
