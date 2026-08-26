import { calculateRisk } from "./riskCalculator";
import { describe, expect, it } from "vitest";

const account = { balance: 10_000, equity: 10_000, margin: 100, freeMargin: 9_900, currency: "USD" };
const spec = { symbol: "XAUUSDm", tickSize: 0.1, tickValueLoss: 10, contractSize: 100, volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01 };

describe("broker-backed risk calculator", () => {
  it("sizes risk from broker tick loss and rounds down to the broker volume step", () => {
    const result = calculateRisk({ basis: "EQUITY", riskPercent: 1, entryPrice: 2350, stopLoss: 2345 }, account, spec);
    expect(result.valid).toBe(true); expect(result.riskAmount).toBe(100); expect(result.stopTicks).toBe(50); expect(result.lossPerLot).toBe(500); expect(result.rawLots).toBe(0.2); expect(result.lots).toBe(0.2); expect(result.actualRisk).toBe(100); expect(result.freeMargin).toBe(9_900); expect(result.riskBudgetUtilization).toBe(100); expect(result.freeMarginRiskPercent).toBeCloseTo(1.01, 2);
  });
  it("refuses a result below the broker minimum without inventing a larger lot", () => {
    const result = calculateRisk({ basis: "BALANCE", riskPercent: 0.01, entryPrice: 2350, stopLoss: 2340 }, account, spec);
    expect(result.valid).toBe(false); expect(result.lots).toBe(0); expect(result.warnings.join(" ")).toContain("minimum");
  });
  it("warns instead of returning a valid size when free margin is not positive", () => {
    const result = calculateRisk({ basis: "EQUITY", riskPercent: 1, entryPrice: 2350, stopLoss: 2345 }, { ...account, freeMargin: 0 }, spec);
    expect(result.valid).toBe(false); expect(result.warnings.join(" ")).toContain("Free margin"); expect(result.freeMarginRiskPercent).toBeNull();
  });
  it("rejects an unsafe risk percentage before any lot size is supplied", () => {
    const result = calculateRisk({ basis: "EQUITY", riskPercent: 11, entryPrice: 2350, stopLoss: 2345 }, account, spec);
    expect(result.valid).toBe(false); expect(result.lots).toBe(0); expect(result.warnings.join(" ")).toContain("10%");
  });
});
