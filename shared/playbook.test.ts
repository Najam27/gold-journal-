import { describe, expect, it } from "vitest";
import { buildAnalysis } from "./analysisEngine";
import { buildPlaybook, PLAYBOOK_MIN_SAMPLE } from "./playbook";

const trade = (overrides: Record<string, unknown> = {}) => ({
  tradeDate: new Date("2026-01-01T00:00:00Z"),
  result: "WIN",
  pnl: 20,
  risk: 10,
  reward: 20,
  session: "London",
  timeframe: "M5",
  level: "Support",
  setupQuality: "A",
  direction: "BUY",
  ...overrides,
});
const dated = (day: number, overrides: Record<string, unknown> = {}) =>
  trade({ tradeDate: new Date(Date.UTC(2026, 0, day)), ...overrides });

describe("trader playbook", () => {
  it("puts a proven positive-expectancy context on the trade list", () => {
    const rows = [...Array(12)].map((_, i) => dated(i + 1, { session: "London", pnl: 20 }));
    const playbook = buildPlaybook(buildAnalysis(rows));
    expect(playbook.trade.length).toBeGreaterThan(0);
    const card = playbook.trade[0];
    expect(card.expectancy).toBeGreaterThan(0);
    expect(card.sample).toBeGreaterThanOrEqual(PLAYBOOK_MIN_SAMPLE);
    expect(card.headline).toContain("London");
    expect(card.action.length).toBeGreaterThan(0);
  });

  it("puts a proven money-losing context on the avoid list", () => {
    const rows = [
      ...[...Array(12)].map((_, i) => dated(i + 1, { marketCondition: "News-driven", result: "LOSS", pnl: -15 })),
      ...[...Array(12)].map((_, i) => dated(13 + i, { marketCondition: "Trending", pnl: 20 })),
    ];
    const playbook = buildPlaybook(buildAnalysis(rows));
    const avoid = playbook.avoid.find(card => card.label === "News-driven");
    expect(avoid).toBeDefined();
    expect(avoid!.expectancy).toBeLessThan(0);
    expect(avoid!.action).toMatch(/skip|half size/i);
  });

  it("uses the new option dimensions (market condition, execution type, bias)", () => {
    const rows = [
      ...[...Array(12)].map((_, i) => dated(i + 1, { executionType: "Limit Order", pnl: 20 })),
      ...[...Array(12)].map((_, i) => dated(13 + i, { executionType: "Manual Direct", result: "LOSS", pnl: -10 })),
    ];
    const analysis = buildAnalysis(rows);
    expect(analysis.executionTypes.length).toBeGreaterThan(0);
    const playbook = buildPlaybook(analysis);
    const labels = [...playbook.trade, ...playbook.avoid].map(card => card.label);
    expect(labels).toContain("Limit Order");
  });

  it("refuses to mint playbook cards from thin samples", () => {
    const rows = [...Array(6)].map((_, i) => dated(i + 1, { pnl: 50 }));
    const playbook = buildPlaybook(buildAnalysis(rows));
    expect(playbook.trade).toHaveLength(0);
    expect(playbook.avoid).toHaveLength(0);
    expect(playbook.note).toMatch(/unlocks as your journal grows/);
  });

  it("caps each list at three cards and never repeats a label", () => {
    const rows: Record<string, unknown>[] = [];
    const sessions = ["London", "New York", "Asian", "Pre-London", "Post-NY"];
    sessions.forEach((session, s) => {
      for (let i = 0; i < 12; i += 1) rows.push(dated(s * 12 + i + 1, { session, pnl: 10 + s }));
    });
    const playbook = buildPlaybook(buildAnalysis(rows));
    expect(playbook.trade.length).toBeLessThanOrEqual(3);
    const labels = playbook.trade.map(card => card.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
