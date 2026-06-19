import { describe, expect, it } from "vitest";
import { normalizeRow, parseExpiryToIso, pickContract, toRaw } from "./bhavcopy.mjs";

// Fixture resembling MCX GetDateWiseBhavCopy rows (mixed casing, two expiries,
// a decoy symbol, and an illiquid zero-priced option that must be dropped).
const ROWS = [
  { InstrumentName: "FUTCOM", Symbol: "SILVER", ExpiryDate: "04JUL2026", OptionType: "", StrikePrice: 0, Close: 275500, PreviousClose: 273900, OpenInterest: 18420 },
  { InstrumentName: "FUTCOM", Symbol: "SILVER", ExpiryDate: "05SEP2026", OptionType: "", StrikePrice: 0, Close: 279000, PreviousClose: 277500, OpenInterest: 4200 },
  { InstrumentName: "OPTFUT", Symbol: "SILVER", ExpiryDate: "04JUL2026", OptionType: "CE", StrikePrice: 275000, Close: 4100, OpenInterest: 4200 },
  { InstrumentName: "OPTFUT", Symbol: "SILVER", ExpiryDate: "04JUL2026", OptionType: "PE", StrikePrice: 270000, Close: 2950, OpenInterest: 3400 },
  { InstrumentName: "OPTFUT", Symbol: "SILVER", ExpiryDate: "04JUL2026", OptionType: "CE", StrikePrice: 285000, Close: 1500, OpenInterest: 2750 },
  { InstrumentName: "OPTFUT", Symbol: "SILVER", ExpiryDate: "04JUL2026", OptionType: "PE", StrikePrice: 260000, Close: 0, OpenInterest: 100 }, // illiquid -> dropped
  { InstrumentName: "OPTFUT", Symbol: "SILVER", ExpiryDate: "05SEP2026", OptionType: "CE", StrikePrice: 280000, Close: 5000, OpenInterest: 900 }, // wrong expiry
  { InstrumentName: "FUTCOM", Symbol: "GOLD", ExpiryDate: "04JUL2026", OptionType: "", StrikePrice: 0, Close: 9999999, OpenInterest: 1 }, // decoy symbol
];

const TODAY = "2026-06-19";

describe("parseExpiryToIso", () => {
  it("handles DDMMMYYYY, ISO and dd-mm-yyyy", () => {
    expect(parseExpiryToIso("04JUL2026")).toBe("2026-07-04");
    expect(parseExpiryToIso("2026-07-04")).toBe("2026-07-04");
    expect(parseExpiryToIso("04-07-2026")).toBe("2026-07-04");
    expect(parseExpiryToIso("")).toBeNull();
    expect(parseExpiryToIso(null)).toBeNull();
  });
});

describe("normalizeRow", () => {
  it("classifies futures vs options case-insensitively", () => {
    const fut = normalizeRow(ROWS[0]);
    expect(fut.isFuture).toBe(true);
    expect(fut.isOption).toBe(false);
    const opt = normalizeRow(ROWS[2]);
    expect(opt.isOption).toBe(true);
    expect(opt.optionType).toBe("CE");
  });
});

describe("pickContract", () => {
  it("selects the front-month SILVER future and its chain only", () => {
    const c = pickContract(ROWS, "SILVER", TODAY);
    expect(c.expiry).toBe("2026-07-04");
    expect(c.future.close).toBe(275500);
    expect(c.future.prevClose).toBe(273900);
    expect(c.future.oi).toBe(18420);
    // 3 valid July options (zero-priced + Sept + GOLD excluded)
    expect(c.chain).toHaveLength(3);
    expect(c.chain.every((o) => o.ltp > 0)).toBe(true);
    expect(c.chain.map((o) => o.strike)).toEqual([270000, 275000, 285000]); // sorted
  });

  it("returns null when the symbol has no future", () => {
    expect(pickContract(ROWS, "COPPER", TODAY)).toBeNull();
  });
});

describe("toRaw", () => {
  it("maps to the pipeline shape and computes OI change vs previous day", () => {
    const prev = ROWS.map((r) =>
      r.Symbol === "SILVER" && r.InstrumentName === "FUTCOM" && r.ExpiryDate === "04JUL2026"
        ? { ...r, OpenInterest: 17000 }
        : r,
    );
    const raw = toRaw(ROWS, "SILVER", TODAY, prev);
    expect(raw.silverFut).toBe(275500);
    expect(raw.expiry).toBe("2026-07-04");
    expect(raw.oiChg).toBe(18420 - 17000);
    expect(raw.chain).toHaveLength(3);
  });

  it("oiChg is null when no previous day is supplied", () => {
    const raw = toRaw(ROWS, "SILVER", TODAY, null);
    expect(raw.oiChg).toBeNull();
  });
});
