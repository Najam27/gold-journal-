import { describe, expect, it } from "vitest";
import { filterAnalysisTrades } from "./analysisEngine";

describe("analysis PKT date filters", () => {
  it("keeps only trades inside the selected UTC+5 calendar day", () => {
    const trades = [
      { tradeDate: "2026-08-03T18:59:59.000Z", result: "WIN", pnl: 10 },
      { tradeDate: "2026-08-03T19:00:00.000Z", result: "WIN", pnl: 20 },
      { tradeDate: "2026-08-04T18:59:59.000Z", result: "LOSS", pnl: -5 },
      { tradeDate: "2026-08-04T19:00:00.000Z", result: "LOSS", pnl: -10 },
    ];
    expect(filterAnalysisTrades(trades, { startDate: "2026-08-04", endDate: "2026-08-04" }).map(trade => trade.pnl)).toEqual([20, -5]);
  });
});
