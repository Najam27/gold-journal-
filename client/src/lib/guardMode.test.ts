import { describe, expect, it } from "vitest";
import {
  evaluateGuardMode,
  type GuardConfig,
  type GuardModeCashInput,
  type GuardModeTradeInput,
} from "./guardMode";

/**
 * Funded-account guard mode: a prop account dies by rule breach, not by bad
 * strategy. These tests pin the OFF/CLEAR/WARNING/BREACHED state machine, the
 * 80%/100% thresholds, and the realized-only accounting choices (OPEN trades
 * never move P&L or equity; misconfigured limits never insta-breach).
 */

const TODAY = new Date("2026-09-27T10:00:00+05:00");
const YESTERDAY = new Date("2026-09-26T15:00:00+05:00");

const baseConfig: GuardConfig = {
  enabled: true,
  accountSize: 100000,
  dailyLossLimit: 2000,
  maxDrawdownLimit: 5000,
  maxTradesPerDay: 5,
};

const trade = (overrides: Partial<GuardModeTradeInput> = {}): GuardModeTradeInput => ({
  tradeDate: TODAY,
  pnl: -100,
  result: "LOSS",
  ...overrides,
});

const cash = (overrides: Partial<GuardModeCashInput> = {}): GuardModeCashInput => ({
  movementDate: YESTERDAY,
  amount: 1000,
  type: "DEPOSIT",
  ...overrides,
});

function evaluate(overrides: Partial<Parameters<typeof evaluateGuardMode>[0]> = {}) {
  return evaluateGuardMode({
    trades: [],
    startingBalance: 100000,
    config: baseConfig,
    today: TODAY,
    ...overrides,
  });
}

describe("evaluateGuardMode", () => {
  it("is OFF with a null config", () => {
    const result = evaluate({ config: null });
    expect(result.status).toBe("OFF");
    expect(result.message).toBe("Guard mode is off.");
    expect(result.breached).toEqual([]);
    expect(result.warned).toEqual([]);
    expect(result.dayLossUsedPct).toBeNull();
  });

  it("is OFF when disabled", () => {
    const result = evaluate({ config: { ...baseConfig, enabled: false } });
    expect(result.status).toBe("OFF");
    expect(result.message).toBe("Guard mode is off.");
  });

  it("is CLEAR with no usage", () => {
    const result = evaluate();
    expect(result.status).toBe("CLEAR");
    expect(result.dayPnl).toBe(0);
    expect(result.dayTrades).toBe(0);
    expect(result.message).toContain("clear");
  });

  it("is CLEAR on a winning day", () => {
    const result = evaluate({ trades: [trade({ pnl: 500, result: "WIN" }), trade({ pnl: 300, result: "WIN" })] });
    expect(result.status).toBe("CLEAR");
    expect(result.dayPnl).toBe(800);
    expect(result.dayLossUsedPct).toBeNull(); // no loss, no percentage
    expect(result.drawdown).toBe(0);
  });

  it("warns at exactly 80% of the daily loss limit", () => {
    // 80% of $2,000 = $1,600
    const result = evaluate({ trades: [trade({ pnl: -1600 })] });
    expect(result.dayLossUsedPct).toBe(80);
    expect(result.status).toBe("WARNING");
    expect(result.warned).toHaveLength(1);
    expect(result.warned[0]).toContain("-$1,600.00");
    expect(result.warned[0]).toContain("$2,000.00");
    expect(result.breached).toEqual([]);
  });

  it("breaches at 100% of the daily loss limit", () => {
    const result = evaluate({ trades: [trade({ pnl: -2050 })] });
    expect(result.status).toBe("BREACHED");
    expect(result.dayLossUsedPct).toBe(102.5);
    expect(result.breached).toHaveLength(1);
    expect(result.breached[0]).toContain("-$2,050.00");
    expect(result.breached[0]).toContain("$2,000.00");
    expect(result.message).toContain("breached");
  });

  it("warns just below 100% but breaches at exactly the limit", () => {
    const justUnder = evaluate({ trades: [trade({ pnl: -1999.99 })] });
    expect(justUnder.status).toBe("WARNING");
    const exact = evaluate({ trades: [trade({ pnl: -2000 })] });
    expect(exact.dayLossUsedPct).toBe(100);
    expect(exact.status).toBe("BREACHED");
  });

  it("ignores null/zero limits entirely", () => {
    const result = evaluate({
      config: { enabled: true, accountSize: null, dailyLossLimit: null, maxDrawdownLimit: 0, maxTradesPerDay: -3 },
      trades: [trade({ pnl: -999999 })],
    });
    expect(result.status).toBe("CLEAR");
    expect(result.dayLossUsedPct).toBeNull();
    expect(result.drawdownUsedPct).toBeNull();
    expect(result.tradesUsedPct).toBeNull();
  });

  it("excludes OPEN trades from dayPnl but counts them in dayTrades", () => {
    const result = evaluate({
      trades: [trade({ pnl: -1500, result: "OPEN" }), trade({ pnl: -400, result: "LOSS" })],
    });
    // Floating P&L is not a realized breach: only the closed -$400 counts.
    expect(result.dayPnl).toBe(-400);
    expect(result.dayTrades).toBe(2);
    expect(result.status).toBe("CLEAR");
  });

  it("only counts trades from the PKT calendar day", () => {
    const result = evaluate({
      trades: [trade({ pnl: -1900, tradeDate: YESTERDAY }), trade({ pnl: -100 })],
    });
    expect(result.dayPnl).toBe(-100);
    expect(result.dayTrades).toBe(1);
    expect(result.status).toBe("CLEAR");
  });

  it("tracks drawdown across deposits with a running high-water peak", () => {
    // Start 100k, deposit 5k -> peak 105k, then lose 1k -> drawdown 1k.
    const result = evaluate({
      trades: [trade({ pnl: -1000, tradeDate: TODAY })],
      cashMovements: [cash({ movementDate: new Date("2026-09-25T10:00:00+05:00"), amount: 5000, type: "DEPOSIT" })],
    });
    expect(result.peakEquity).toBe(105000);
    expect(result.currentEquity).toBe(104000);
    expect(result.drawdown).toBe(1000);
    expect(result.drawdownUsedPct).toBe(20);
    expect(result.status).toBe("CLEAR");
  });

  it("breaches the max drawdown limit at 100%", () => {
    const result = evaluate({
      config: { ...baseConfig, maxDrawdownLimit: 1000 },
      trades: [trade({ pnl: -1000 })],
    });
    expect(result.drawdownUsedPct).toBe(100);
    expect(result.status).toBe("BREACHED");
    expect(result.breached[0]).toContain("drawdown");
    expect(result.breached[0]).toContain("$1,000.00");
  });

  it("withdrawals reduce equity and can create drawdown", () => {
    const result = evaluate({
      config: { ...baseConfig, maxDrawdownLimit: 500 },
      cashMovements: [cash({ movementDate: TODAY, amount: 500, type: "WITHDRAW" })],
    });
    expect(result.currentEquity).toBe(99500);
    expect(result.drawdown).toBe(500);
    expect(result.status).toBe("BREACHED");
  });

  it("warns at the trade cap but breaches only when strictly over it", () => {
    const atCap = evaluate({ trades: Array.from({ length: 5 }, () => trade({ pnl: 10, result: "WIN" })) });
    expect(atCap.dayTrades).toBe(5);
    expect(atCap.tradesUsedPct).toBe(100);
    expect(atCap.status).toBe("WARNING");
    expect(atCap.warned[0]).toContain("5 of 5");

    const overCap = evaluate({ trades: Array.from({ length: 6 }, () => trade({ pnl: 10, result: "WIN" })) });
    expect(overCap.status).toBe("BREACHED");
    expect(overCap.breached[0]).toContain("6 of 5");
  });

  it("warns at the 80% rung of the trade cap (rounded up)", () => {
    // max 5 -> ceil(4) = 4 trades warns
    const result = evaluate({ trades: Array.from({ length: 4 }, () => trade({ pnl: 10, result: "WIN" })) });
    expect(result.status).toBe("WARNING");
    const three = evaluate({ trades: Array.from({ length: 3 }, () => trade({ pnl: 10, result: "WIN" })) });
    expect(three.status).toBe("CLEAR");
  });

  it("prefers BREACHED status and message when multiple limits trip", () => {
    const result = evaluate({
      trades: [trade({ pnl: -2500 }), ...Array.from({ length: 6 }, () => trade({ pnl: 10, result: "WIN" }))],
    });
    expect(result.status).toBe("BREACHED");
    expect(result.breached).toHaveLength(2);
    expect(result.message).toContain("breached");
  });

  it("skips trades and movements with invalid dates", () => {
    const result = evaluate({
      trades: [trade({ tradeDate: "not-a-date", pnl: -5000 })],
      cashMovements: [cash({ movementDate: "also-bad", amount: 99999 })],
    });
    expect(result.dayPnl).toBe(0);
    expect(result.currentEquity).toBe(100000);
    expect(result.status).toBe("CLEAR");
  });
});
