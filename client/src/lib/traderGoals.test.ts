import { describe, expect, it } from "vitest";
import { assessTraderGoal } from "./traderGoals";
import { encodeGoalControl } from "@shared/goalStrategy";

const now = new Date("2026-08-12T12:00:00Z");
const rows = [{ id: 1, tradeDate: "2026-08-12T08:00:00Z", result: "LOSS", pnl: "-120", risk: "60", reward: "120", patienceScore: 2, setupQuality: "B", mistake: "Revenge trade" }, { id: 2, tradeDate: "2026-08-12T10:00:00Z", result: "LOSS", pnl: "-60", risk: "60", reward: "120", patienceScore: 3, setupQuality: "A" }];
describe("professional trader goal assessment", () => {
  it("uses a negative P&L floor for loss controls and keeps legacy positive loss limits compatible", () => {
    const breached = assessTraderGoal({ id: 1, name: "Loss", period: "DAILY", metric: "daily_loss", comparison: "LTE", target: "-150", active: true }, rows, [], now);
    const atRisk = assessTraderGoal({ id: 2, name: "Loss", period: "DAILY", metric: "daily_loss", comparison: "LTE", target: "-200", active: true }, rows, [], now);
    const legacyPositive = assessTraderGoal({ id: 3, name: "Legacy loss", period: "DAILY", metric: "daily_loss", comparison: "LTE", target: "150", active: true }, rows, [], now);
    expect(breached).toMatchObject({ value: -180, target: -150, current: "-$180.00", targetLabel: "-$150.00", status: "BREACHED", rows: 2 });
    expect(atRisk).toMatchObject({ value: -180, target: -200, status: "AT_RISK", remaining: 20 });
    expect(legacyPositive).toMatchObject({ target: -150, status: "BREACHED" });
  });
  it("derives consecutive losses and revenge-tag count from actual saved execution data", () => { expect(assessTraderGoal({ id: 2, name: "Streak", period: "DAILY", metric: "consecutive_losses", comparison: "LTE", target: "2", active: true }, rows, [], now).value).toBe(2); expect(assessTraderGoal({ id: 3, name: "Revenge", period: "DAILY", metric: "revenge_trades", comparison: "LTE", target: "0", active: true }, rows, [], now).status).toBe("BREACHED"); });
  it("marks active performance targets as in progress instead of falsely pending", () => { expect(assessTraderGoal({ id: 4, name: "Profit", period: "MONTHLY", metric: "net_pnl", comparison: "GTE", target: "500", active: true }, rows, [], now).status).toBe("IN_PROGRESS"); });
  it("excludes open positions from goal progress, risk guardrails, and activity", () => {
    const openOnly = [{ id: 8, tradeDate: "2026-08-12T10:00:00Z", result: "OPEN", pnl: "-500", risk: "100", reward: "300", patienceScore: 1, setupQuality: "A", mistake: "Revenge trade" }];
    expect(assessTraderGoal({ id: 8, name: "Loss cap", period: "DAILY", metric: "daily_loss", comparison: "LTE", target: "100", active: true }, openOnly, [], now)).toMatchObject({ value: 0, rows: 0, hasActivity: false, status: "PENDING" });
  });

  it("tracks concrete behavior tags and a daily trade cap without relying on generic metrics", () => {
    const behaviorRows = [...rows, { id: 3, tradeDate: "2026-08-12T11:00:00Z", result: "WIN", pnl: "80", risk: "40", reward: "80", mistake: "FOMO" }, { id: 4, tradeDate: "2026-08-12T11:30:00Z", result: "WIN", pnl: "50", risk: "25", reward: "50", mistake: "Overtrading | Oversize" }];
    expect(assessTraderGoal({ id: 9, name: "No FOMO", period: "DAILY", metric: "fomo_trades", comparison: "LTE", target: 0, active: true }, behaviorRows, [], now)).toMatchObject({ value: 1, status: "BREACHED" });
    expect(assessTraderGoal({ id: 10, name: "Cap", period: "DAILY", metric: "trade_count", comparison: "LTE", target: 3, active: true }, behaviorRows, [], now)).toMatchObject({ value: 4, status: "BREACHED" });
    expect(assessTraderGoal({ id: 11, name: "Oversize", period: "DAILY", metric: "oversize_trades", comparison: "LTE", target: 0, active: true }, behaviorRows, [], now).value).toBe(1);
  });

  it("consolidates the four behavior patterns without double-counting a multi-tagged trade and evaluates journal-backed quality controls", () => {
    const journalRows = [
      { id: 20, tradeDate: "2026-08-12T08:00:00Z", result: "LOSS", pnl: "-30", risk: "30", reward: "60", mistake: "FOMO | Revenge" },
      { id: 21, tradeDate: "2026-08-12T10:00:00Z", result: "WIN", pnl: "40", risk: "20", reward: "40", mistake: "Oversize" },
      { id: 22, tradeDate: "2026-08-12T11:00:00Z", result: "WIN", pnl: "20", risk: null, reward: null, mistake: "" },
    ];
    const reviews = [{ planDate: "2026-08-12T03:00:00Z", overallRating: 4 }];
    expect(assessTraderGoal({ id: 20, name: "Behavior", period: "DAILY", metric: "behavior_breaches", comparison: "LTE", target: 1, active: true }, journalRows, reviews, now)).toMatchObject({ value: 2, status: "BREACHED" });
    expect(assessTraderGoal({ id: 21, name: "Risk", period: "WEEKLY", metric: "risk_defined_rate", comparison: "GTE", target: 60, active: true }, journalRows, reviews, now)).toMatchObject({ value: 66.66666666666666, status: "MET" });
    expect(assessTraderGoal({ id: 22, name: "Protocol", period: "WEEKLY", metric: "session_plan_rate", comparison: "GTE", target: 100, active: true }, journalRows, reviews, now)).toMatchObject({ value: 100, status: "MET" });
    expect(assessTraderGoal({ id: 23, name: "Review", period: "WEEKLY", metric: "process_quality", comparison: "GTE", target: 4, active: true }, journalRows, reviews, now)).toMatchObject({ value: 4, status: "MET" });
    expect(assessTraderGoal({ id: 24, name: "Sample", period: "MONTHLY", metric: "minimum_sample", comparison: "GTE", target: 5, active: true }, journalRows, reviews, now)).toMatchObject({ value: 3, status: "IN_PROGRESS" });
  });

  it("measures strategy compliance against the selected execution scope and ignores off-scope trades", () => {
    const scopedRows = [{ id: 1, tradeDate: "2026-08-12T08:00:00Z", result: "WIN", pnl: "100", session: "London", timeframe: "15m", level: "RBS | TLJ", setupQuality: "A", mistake: "" }, { id: 2, tradeDate: "2026-08-12T10:00:00Z", result: "LOSS", pnl: "-50", session: "London", timeframe: "15m", level: "RBS", setupQuality: "B", mistake: "Early entry" }, { id: 3, tradeDate: "2026-08-12T11:00:00Z", result: "WIN", pnl: "40", session: "New York", timeframe: "15m", level: "TLJ", setupQuality: "A", mistake: "" }];
    const scoped = assessTraderGoal({ id: 12, name: "London A setup", description: encodeGoalControl("Only A London entries.", { session: "London", timeframe: "15m", level: "TLJ", setupQuality: "A" }), period: "WEEKLY", metric: "strategy_compliance", comparison: "GTE", target: 80, active: true }, scopedRows, [], now);
    expect(scoped).toMatchObject({ value: 33.33333333333333, status: "IN_PROGRESS", scopeLabel: "London · 15m · TLJ · A" });
  });
});
