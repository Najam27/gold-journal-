import { describe, expect, it } from "vitest";
import { buildTradingEdge, EDGE_MIN_SAMPLE } from "./tradingEdge";

describe("buildTradingEdge", () => {
  const trades = [
    { session: "London", timeframe: "15m", level: "QML", result: "WIN", pnl: 120 },
    { session: "London", timeframe: "15m", level: "QML", result: "WIN", pnl: 80 },
    { session: "London", timeframe: "15m", level: "QML", result: "LOSS", pnl: -40 },
    { session: "London", timeframe: "15m", level: "QML", result: "WIN", pnl: 100 },
    { session: "London", timeframe: "15m", level: "QML", result: "BREAK_EVEN", pnl: 0 },
    { session: "Asian", timeframe: "5m", level: "FIB", result: "LOSS", pnl: -50 },
    { session: "Asian", timeframe: "5m", level: "FIB", result: "OPEN", pnl: 25 },
  ];

  it("groups real closed-trade performance by dimensions and ignores open trades", () => {
    const edge = buildTradingEdge(trades);
    expect(edge.sessions.find(row => row.label === "London")).toMatchObject({ sample: EDGE_MIN_SAMPLE, wins: 3, winRate: 60, netPnl: 260, expectancy: 52, qualified: true });
    expect(edge.sessions.find(row => row.label === "Asian")).toMatchObject({ sample: 1, qualified: false, netPnl: -50 });
    expect(edge.sessionTimeframes.find(row => row.label === "London · 15m")?.qualified).toBe(true);
  });

  it("ranks the strongest qualified context across both single and combined dimensions", () => {
    const edge = buildTradingEdge([
      ...trades,
      { session: "New York", timeframe: "5m", level: "FIB", result: "WIN", pnl: 300 },
      { session: "New York", timeframe: "5m", level: "FIB", result: "WIN", pnl: 200 },
      { session: "New York", timeframe: "5m", level: "FIB", result: "WIN", pnl: 220 },
      { session: "New York", timeframe: "5m", level: "FIB", result: "WIN", pnl: 180 },
      { session: "New York", timeframe: "5m", level: "FIB", result: "WIN", pnl: 210 },
    ]);
    expect(edge.strongest?.label).toBe("New York");
    expect(edge.strongest?.expectancy).toBe(222);
  });
});
