// ---------------------------------------------------------------------------
// Contract matching — the safety-critical part of the MCX pipeline.
//
// If a GOLDM row leaks into SILVERM's chain (or vice versa), every ₹-per-lot
// number downstream is wrong by the ratio of their lot multipliers, silently
// and with no error anywhere. These tests exist to make that impossible.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { matchesSymbol, norm, pickChainContracts } from "./upstox.mjs";
import { allContractSymbols } from "../src/lib/metals.mjs";

const SIBLINGS = allContractSymbols();

/** Build a normalized row the same way the pipeline does. */
const row = ({ name, tradingSymbol, type = "FUTCOM", expiry = "2026-08-31", strike = 0, optionType }) =>
  norm({
    instrument_key: `MCX_FO|${tradingSymbol}`,
    name,
    trading_symbol: tradingSymbol,
    instrument_type: type,
    option_type: optionType,
    expiry,
    strike_price: strike,
  });

describe("matchesSymbol — symbol boundaries", () => {
  it("matches a contract by its exact name", () => {
    expect(matchesSymbol(row({ name: "SILVERM", tradingSymbol: "SILVERM26AUGFUT" }), "SILVERM", SIBLINGS)).toBe(true);
  });

  it("matches by trading symbol when the name field is absent", () => {
    expect(matchesSymbol(row({ tradingSymbol: "GOLDM26AUGFUT" }), "GOLDM", SIBLINGS)).toBe(true);
  });

  // The regression that motivated this whole guard.
  it("does NOT let GOLD swallow GOLDM", () => {
    const goldm = row({ name: "GOLDM", tradingSymbol: "GOLDM26AUGFUT" });
    expect(matchesSymbol(goldm, "GOLD", SIBLINGS)).toBe(false);
  });

  it("does NOT let GOLD swallow GOLDPETAL or GOLDGUINEA", () => {
    for (const ts of ["GOLDPETAL26AUGFUT", "GOLDGUINEA26AUGFUT"]) {
      expect(matchesSymbol(row({ tradingSymbol: ts }), "GOLD", SIBLINGS)).toBe(false);
    }
  });

  it("does NOT let SILVER swallow SILVERM or SILVERMIC", () => {
    expect(matchesSymbol(row({ name: "SILVERM", tradingSymbol: "SILVERM26AUGFUT" }), "SILVER", SIBLINGS)).toBe(false);
    expect(matchesSymbol(row({ name: "SILVERMIC", tradingSymbol: "SILVERMIC26AUGFUT" }), "SILVER", SIBLINGS)).toBe(false);
  });

  it("does NOT let SILVERM swallow SILVERMIC (prefix of a prefix)", () => {
    const mic = row({ name: "SILVERMIC", tradingSymbol: "SILVERMIC26AUGFUT" });
    expect(matchesSymbol(mic, "SILVERM", SIBLINGS)).toBe(false);
  });

  it("rejects a mini row even when the feed puts the BASE commodity in `name`", () => {
    // Some feeds label a GOLDM row with name "GOLD". The boundary rule can't
    // catch that — the siblings check must.
    const mislabelled = row({ name: "GOLD", tradingSymbol: "GOLDM26AUGFUT" });
    expect(matchesSymbol(mislabelled, "GOLD", SIBLINGS)).toBe(false);
    expect(matchesSymbol(mislabelled, "GOLDM", SIBLINGS)).toBe(true);
  });

  it("keeps the metals mutually exclusive across the whole registry", () => {
    const rows = [
      { sym: "SILVERM", r: row({ name: "SILVERM", tradingSymbol: "SILVERM26AUGFUT" }) },
      { sym: "SILVERMIC", r: row({ name: "SILVERMIC", tradingSymbol: "SILVERMIC26AUGFUT" }) },
      { sym: "GOLDM", r: row({ name: "GOLDM", tradingSymbol: "GOLDM26AUGFUT" }) },
      { sym: "COPPER", r: row({ name: "COPPER", tradingSymbol: "COPPER26AUGFUT" }) },
    ];
    for (const { sym, r } of rows) {
      const hits = SIBLINGS.filter((s) => matchesSymbol(r, s, SIBLINGS));
      expect(hits, `${sym} row matched ${hits.join(",")}`).toEqual([sym]);
    }
  });
});

describe("pickChainContracts — no cross-contract leakage", () => {
  const today = "2026-08-01";
  // A master containing both SILVERM and SILVERMIC futures + options.
  const master = [
    { instrument_key: "k1", name: "SILVERM", trading_symbol: "SILVERM26AUGFUT", instrument_type: "FUTCOM", expiry: "2026-08-31" },
    { instrument_key: "k2", name: "SILVERM", trading_symbol: "SILVERM26AUG120000CE", instrument_type: "OPTFUT", option_type: "CE", expiry: "2026-08-24", strike_price: 120000 },
    { instrument_key: "k3", name: "SILVERM", trading_symbol: "SILVERM26AUG120000PE", instrument_type: "OPTFUT", option_type: "PE", expiry: "2026-08-24", strike_price: 120000 },
    { instrument_key: "k4", name: "SILVERMIC", trading_symbol: "SILVERMIC26AUGFUT", instrument_type: "FUTCOM", expiry: "2026-08-31" },
    { instrument_key: "k5", name: "SILVERMIC", trading_symbol: "SILVERMIC26AUG120000CE", instrument_type: "OPTFUT", option_type: "CE", expiry: "2026-08-24", strike_price: 120000 },
    { instrument_key: "k6", name: "GOLDM", trading_symbol: "GOLDM26AUGFUT", instrument_type: "FUTCOM", expiry: "2026-08-31" },
    { instrument_key: "k7", name: "GOLDM", trading_symbol: "GOLDM26AUG130000CE", instrument_type: "OPTFUT", option_type: "CE", expiry: "2026-08-24", strike_price: 130000 },
  ];

  it("returns only SILVERM legs for SILVERM", () => {
    const out = pickChainContracts(master, "SILVERM", today, 4, SIBLINGS);
    expect(out.length).toBe(1);
    const keys = out[0].options.map((o) => o.key);
    expect(keys.sort()).toEqual(["k2", "k3"]);
    expect(out[0].future.key).toBe("k1");
  });

  it("returns only GOLDM legs for GOLDM", () => {
    const out = pickChainContracts(master, "GOLDM", today, 4, SIBLINGS);
    expect(out.length).toBe(1);
    expect(out[0].options.map((o) => o.key)).toEqual(["k7"]);
    expect(out[0].future.key).toBe("k6");
  });

  it("returns only SILVERMIC legs for SILVERMIC", () => {
    const out = pickChainContracts(master, "SILVERMIC", today, 4, SIBLINGS);
    expect(out[0].options.map((o) => o.key)).toEqual(["k5"]);
    expect(out[0].future.key).toBe("k4");
  });
});
