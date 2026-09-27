import { describe, expect, it } from "vitest";
import { buildAnalysis } from "./analysisEngine";
import { buildMentorBrief } from "./mentorEngine";

const trade = (overrides: Record<string, unknown> = {}) => ({
  tradeDate: new Date("2026-01-01T00:00:00Z"),
  result: "WIN",
  pnl: 10,
  risk: 10,
  reward: 20,
  session: "London",
  timeframe: "M5",
  level: "Support",
  setupQuality: "A",
  direction: "BUY",
  notes: "reviewed",
  ...overrides,
});
const dated = (day: number, overrides: Record<string, unknown> = {}) =>
  trade({ tradeDate: new Date(Date.UTC(2026, 0, day)), ...overrides });

describe("deterministic mentor brief", () => {
  it("tells an empty journal to keep collecting instead of inventing advice", () => {
    const brief = buildMentorBrief(buildAnalysis([]));
    expect(brief.sample).toBe(0);
    expect(brief.readiness).toBe("COLLECTING");
    expect(brief.nextAction).toBeTruthy();
    expect(brief.insights[0]?.title).toBe("Still collecting data");
  });

  it("flags trading-after-losses as the top fix when losers follow losers", () => {
    const rows = [...Array(8)].map((_, i) => dated(i + 1, { pnl: 30 }));
    for (let i = 0; i < 6; i += 1) rows.push(dated(9 + i, { result: "LOSS", pnl: -25 }));
    const brief = buildMentorBrief(buildAnalysis(rows));
    const fix = brief.insights.find(item => item.title === "Losses change your trading");
    expect(fix?.level).toBe("fix");
    // Fixes sort before watches and strengths; the single next action is the fix.
    expect(brief.insights[0]?.level).toBe("fix");
    expect(brief.nextAction).toBe(fix?.action);
  });

  it("praises a genuine edge instead of only listing problems", () => {
    const rows = [...Array(40)].map((_, i) =>
      dated(i + 1, i % 5 < 3 ? { pnl: 20 } : { result: "LOSS", pnl: -10 })
    );
    const brief = buildMentorBrief(buildAnalysis(rows));
    expect(brief.readiness).toBe("MEANINGFUL");
    expect(brief.insights.some(item => item.level === "strength")).toBe(true);
  });

  it("never emits an insight without traceable evidence", () => {
    const rows = [...Array(12)].map((_, i) =>
      dated(i + 1, i % 3 === 0 ? { result: "LOSS", pnl: -10 } : { pnl: 20 })
    );
    const brief = buildMentorBrief(buildAnalysis(rows));
    expect(brief.insights.length).toBeGreaterThan(0);
    for (const insight of brief.insights) {
      expect(insight.title.length).toBeGreaterThan(0);
      expect(insight.message.length).toBeGreaterThan(0);
      expect(insight.action.length).toBeGreaterThan(0);
      expect(insight.evidence.length).toBeGreaterThan(0);
    }
  });
});
