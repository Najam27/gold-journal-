import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_DRAWDOWN_PCT,
  DEFAULT_MAX_DRAWDOWN_PCT,
  evaluateFundedGuard,
} from "./fundedGuard";

const base = {
  accountSize: 100_000,
  dailyDrawdownPct: DEFAULT_DAILY_DRAWDOWN_PCT,
  maxDrawdownPct: DEFAULT_MAX_DRAWDOWN_PCT,
  drawdownType: "static" as const,
};

describe("evaluateFundedGuard", () => {
  it("computes FTMO-style limits: 5% daily = $5k, 10% max = $10k on $100k", () => {
    const result = evaluateFundedGuard(base);
    expect(result.dailyLossLimit).toBe(5_000);
    expect(result.maxLossLimit).toBe(10_000);
    expect(result.maxDrawdownFloor).toBe(90_000);
    expect(result.level).toBe("clear");
  });

  it("caps single-trade risk at 30% of the daily allowance", () => {
    const result = evaluateFundedGuard(base);
    expect(result.maxRiskPerTrade).toBe(1_500); // 30% of $5,000
  });

  it("counts whole stops before the daily limit breaks", () => {
    const result = evaluateFundedGuard(base, 0, 1_500);
    expect(result.stopsBeforeDailyBreach).toBe(3); // floor(5000 / 1500)
  });

  it("tracks daily usage from today's P&L", () => {
    const result = evaluateFundedGuard(base, -2_500);
    expect(result.dailyUsedPct).toBe(50);
    expect(result.dailyRemaining).toBe(2_500);
    expect(result.level).toBe("clear");
  });

  it("warns at 70% (caution) and 90% (danger) of the daily limit", () => {
    expect(evaluateFundedGuard(base, -3_500).level).toBe("caution");
    expect(evaluateFundedGuard(base, -4_500).level).toBe("danger");
  });

  it("marks breached at or past 100% of the daily limit", () => {
    expect(evaluateFundedGuard(base, -5_000).level).toBe("breached");
    expect(evaluateFundedGuard(base, -6_000).level).toBe("breached");
  });

  it("trailing drawdown locks the floor to peak equity", () => {
    const result = evaluateFundedGuard({ ...base, drawdownType: "trailing", peakEquity: 110_000 });
    expect(result.maxDrawdownFloor).toBe(100_000); // 110k - 10k
  });

  it("trailing never drops the floor below the static level", () => {
    const result = evaluateFundedGuard({ ...base, drawdownType: "trailing", peakEquity: 95_000 });
    expect(result.maxDrawdownFloor).toBe(90_000); // max(100k, 95k) - 10k
  });

  it("handles a custom 3% daily / 6% max firm", () => {
    const result = evaluateFundedGuard({ ...base, dailyDrawdownPct: 3, maxDrawdownPct: 6 });
    expect(result.dailyLossLimit).toBe(3_000);
    expect(result.maxLossLimit).toBe(6_000);
    expect(result.maxRiskPerTrade).toBe(900);
  });

  it("never divides by zero on a zero account size", () => {
    const result = evaluateFundedGuard({ ...base, accountSize: 0 });
    expect(result.dailyLossLimit).toBe(0);
    expect(result.dailyUsedPct).toBe(0);
    expect(result.level).toBe("clear");
  });
});
