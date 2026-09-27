import { describe, expect, it } from "vitest";
import { planDeviationCost } from "./deviationCost";

const t = (planStatus: string | null, result: string, pnl: number) => ({ planStatus, result, pnl });

describe("cost of indiscipline", () => {
  it("separates planned from unplanned P&L and prices the deviation", () => {
    const trades = [
      t("PLANNED", "WIN", 100), t("PLANNED", "WIN", 100), t("PLANNED", "LOSS", -50),
      t("UNPLANNED", "LOSS", -80), t("UNPLANNED", "LOSS", -80),
    ];
    const cost = planDeviationCost(trades);
    expect(cost.plannedTrades).toBe(3);
    expect(cost.plannedPnl).toBe(150);
    expect(cost.plannedExpectancy).toBe(50);
    expect(cost.unplannedTrades).toBe(2);
    expect(cost.unplannedPnl).toBe(-160);
    expect(cost.costOfIndiscipline).toBe(-160);
    expect(cost.verdict).toMatch(/plan works/i);
  });

  it("excludes OPEN trades from the judgment", () => {
    const trades = [t("PLANNED", "WIN", 100), t("UNPLANNED", "OPEN", 9999)];
    const cost = planDeviationCost(trades);
    expect(cost.unplannedTrades).toBe(0);
    expect(cost.plannedPnl).toBe(100);
  });

  it("calls out a journal with no planned trades at all", () => {
    const cost = planDeviationCost([t("UNPLANNED", "LOSS", -50)]);
    expect(cost.verdict).toMatch(/reacting to price/);
  });

  it("warns when unplanned winners are funding bad habits", () => {
    const trades = [
      t("PLANNED", "LOSS", -20), t("PLANNED", "LOSS", -20),
      t("UNPLANNED", "WIN", 200), t("UNPLANNED", "WIN", 200),
    ];
    const cost = planDeviationCost(trades);
    expect(cost.verdict).toMatch(/bad habits/);
  });

  it("handles an empty journal honestly", () => {
    const cost = planDeviationCost([]);
    expect(cost.costOfIndiscipline).toBeNull();
    expect(cost.verdict).toMatch(/No evaluated trades/);
  });
});
