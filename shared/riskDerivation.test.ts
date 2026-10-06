import { describe, expect, it } from "vitest";
import {
  deriveRiskDistances,
  formatDerivedRr,
  formatMagnitude,
  formatMfe,
  normalizeMae,
  normalizeMfe,
} from "./riskDerivation";

describe("deriveRiskDistances", () => {
  it("BUY: Entry 100, SL 95, TP 110 → risk 5, reward 10, R:R 1:2", () => {
    const d = deriveRiskDistances("BUY", 100, 95, 110);
    expect(d.riskDistance).toBe(5);
    expect(d.rewardDistance).toBe(10);
    expect(d.rrRatio).toBeCloseTo(2, 10);
    expect(formatDerivedRr(d.rrRatio)).toBe("1 : 2.00");
    expect(d.slValid).toBe(true);
    expect(d.tpValid).toBe(true);
  });

  it("SELL: Entry 100, SL 105, TP 90 → risk 5, reward 10, R:R 1:2 (never negative)", () => {
    const d = deriveRiskDistances("SELL", 100, 105, 90);
    expect(d.riskDistance).toBe(5);
    expect(d.rewardDistance).toBe(10);
    expect(d.rrRatio).toBeCloseTo(2, 10);
    expect(formatDerivedRr(d.rrRatio)).toBe("1 : 2.00");
    expect(d.slValid).toBe(true);
    expect(d.tpValid).toBe(true);
  });

  it("flags SL/TP on the wrong side of entry without producing negatives", () => {
    const badSl = deriveRiskDistances("BUY", 100, 105, 110);
    expect(badSl.slValid).toBe(false);
    expect(badSl.riskDistance).toBe(5);

    const badTp = deriveRiskDistances("SELL", 100, 105, 110);
    expect(badTp.tpValid).toBe(false);
    expect(badTp.rewardDistance).toBe(10);

    const crossed = deriveRiskDistances("BUY", 100, 110, 90);
    expect(crossed.slValid).toBe(false);
    expect(crossed.tpValid).toBe(false);
  });

  it("returns nulls when inputs are missing", () => {
    const d = deriveRiskDistances("BUY", null, 95, 110);
    expect(d.riskDistance).toBe(null);
    expect(d.rewardDistance).toBe(null);
    expect(d.rrRatio).toBe(null);
    expect(formatDerivedRr(d.rrRatio)).toBe(null);
  });

  it("keeps direction independent: distances follow direction, not bias", () => {
    const buy = deriveRiskDistances("BUY", 2650, 2640, 2670);
    const sell = deriveRiskDistances("SELL", 2650, 2660, 2630);
    expect(buy.riskDistance).toBe(10);
    expect(buy.rewardDistance).toBe(20);
    expect(sell.riskDistance).toBe(10);
    expect(sell.rewardDistance).toBe(20);
  });
});

describe("MAE/MFE normalization", () => {
  it("stores positive magnitudes: MT5 signed extremes become $250 / $180", () => {
    // MT5 tracks mfeUsd = max floating P&L (+250), maeUsd = min (-180).
    expect(normalizeMfe(250)).toBe(250);
    expect(normalizeMae(-180)).toBe(180);
  });

  it("never fabricates: null stays null", () => {
    expect(normalizeMfe(null)).toBe(null);
    expect(normalizeMae(null)).toBe(null);
    expect(normalizeMfe(undefined)).toBe(null);
    expect(normalizeMae(undefined)).toBe(null);
  });

  it("a position that never went positive has $0 MFE; never negative has $0 MAE", () => {
    expect(normalizeMfe(-50)).toBe(0);
    expect(normalizeMae(50)).toBe(0);
  });

  it("formats magnitudes consistently: MFE +$250.00, MAE $180.00", () => {
    expect(formatMfe(250)).toBe("+$250.00");
    expect(formatMfe(-250)).toBe("+$250.00");
    expect(formatMagnitude(180)).toBe("$180.00");
    expect(formatMagnitude(-180)).toBe("$180.00");
    expect(formatMfe(null)).toBe(null);
    expect(formatMagnitude(null)).toBe(null);
  });

  it("keeps MAE/MFE separate from final P&L", () => {
    // MFE 250, MAE 180, final P&L 100: three independent numbers.
    expect(normalizeMfe(250)).toBe(250);
    expect(normalizeMae(-180)).toBe(180);
    expect(normalizeMfe(250)).not.toBe(100);
  });
});
