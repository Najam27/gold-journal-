import { describe, expect, it } from "vitest";
import { formatPips, pipSizeForSymbol, tradePips } from "./pipMath";

describe("pipSizeForSymbol", () => {
  it("uses the gold pip size of 0.1 for XAUUSD and friends", () => {
    expect(pipSizeForSymbol("XAUUSD")).toBe(0.1);
    expect(pipSizeForSymbol("gold")).toBe(0.1);
    expect(pipSizeForSymbol("")).toBe(0.1);
    expect(pipSizeForSymbol(null)).toBe(0.1);
  });
});

describe("tradePips", () => {
  it("computes BUY pips as (exit - entry) / pipSize", () => {
    // The user's own example: 2650.00 -> 2652.00 = +20 pips.
    expect(tradePips({ direction: "BUY", entryPrice: 2650, exitPrice: 2652 })).toBe(20);
  });

  it("computes SELL pips as (entry - exit) / pipSize", () => {
    expect(tradePips({ direction: "SELL", entryPrice: 2652, exitPrice: 2650 })).toBe(20);
    expect(tradePips({ direction: "SELL", entryPrice: 2650, exitPrice: 2652 })).toBe(-20);
  });

  it("returns a losing BUY as negative pips", () => {
    expect(tradePips({ direction: "BUY", entryPrice: 2652, exitPrice: 2650 })).toBe(-20);
  });

  it("returns null when there is no exit leg", () => {
    expect(tradePips({ direction: "BUY", entryPrice: 2650, exitPrice: null })).toBeNull();
    expect(tradePips({ direction: "BUY", entryPrice: 2650 })).toBeNull();
  });

  it("returns null for non-numeric or non-positive prices", () => {
    expect(tradePips({ direction: "BUY", entryPrice: "abc", exitPrice: 2652 })).toBeNull();
    expect(tradePips({ direction: "BUY", entryPrice: 0, exitPrice: 2652 })).toBeNull();
  });

  it("accepts string prices (the DB serializes numerics as strings)", () => {
    expect(tradePips({ direction: "BUY", entryPrice: "2650.00", exitPrice: "2652.00" })).toBe(20);
  });
});

describe("formatPips", () => {
  it("formats with a sign and the pips suffix", () => {
    expect(formatPips(20)).toBe("+20 pips");
    expect(formatPips(-12.34)).toBe("-12.3 pips");
    expect(formatPips(0)).toBe("0 pips");
  });

  it("renders an em dash for missing values", () => {
    expect(formatPips(null)).toBe("—");
    expect(formatPips(undefined)).toBe("—");
    expect(formatPips(NaN)).toBe("—");
  });
});
