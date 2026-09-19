import { describe, expect, it } from "vitest";
import { behaviorConfigFromProfile, buildTraderDevelopment, planBehavioralReview, withBehavioralFeedback } from "./psychology";

/**
 * The adapter is what the Psychology page and the plan review actually call, so
 * these tests pin the two promises it makes: every number comes from saved
 * journal data, and an empty journal reports "no data" rather than a score.
 */

const trade = (day: string, overrides: Record<string, unknown> = {}) => ({
  tradeDate: `${day}T13:00:00+05:00`,
  result: "LOSS",
  pnl: -50,
  risk: 100,
  session: "London",
  planStatus: "PLANNED",
  setupQuality: "A",
  mistake: "",
  ...overrides,
});

describe("trader development adapter", () => {
  it("reports no score at all when nothing has been journalled", () => {
    const report = buildTraderDevelopment({ trades: [], plans: [] });
    expect(report.discipline.score).toBeNull();
    expect(report.focus).toBeNull();
    expect(report.behavioralFeedback.sessions).toBe(0);
    expect(report.behavioralFeedback.objectiveHoldRate).toBeNull();
    expect(report.behavioralFeedback.repeatedTrigger).toBeNull();
    expect(report.behavioralFeedback.nextAction).toBeNull();
    expect(report.behavioralFeedback.note).toMatch(/No triggers or objective verdicts are saved yet/);
  });

  it("summarises the behavioural loop from real saved sessions", () => {
    const report = buildTraderDevelopment({
      trades: [trade("2026-09-15"), trade("2026-09-16"), trade("2026-09-17", { mistake: "FOMO", planStatus: "UNPLANNED" })],
      plans: [
        { planDate: "2026-09-15T08:00:00+05:00", behavioralFocus: "Patience", behavioralObjectiveStatus: "YES" },
        { planDate: "2026-09-16T08:00:00+05:00", behavioralFocus: "Patience", behavioralObjectiveStatus: "PARTIALLY" },
        { planDate: "2026-09-17T08:00:00+05:00", behavioralFocus: "Wait for confirmation", behavioralObjectiveStatus: "NO", psychologyTriggers: ["FOMO", "IMPATIENCE"], postSessionBehavioralReview: { followPlan: "NO", nextSessionChange: "Wait for the close", triggerAction: "Chased the move" } },
      ],
    });
    const feedback = report.behavioralFeedback;
    expect(feedback.sessions).toBe(3);
    expect(feedback.focusLabel).toBe("Wait for confirmation");
    expect(feedback.focusStatus).toBe("NO");
    expect(feedback.reviewedSessions).toBe(3);
    expect(feedback.objectiveHoldRate).toBe(50);
    expect(feedback.triggerCounts.map(entry => entry.key)).toEqual(["FOMO", "IMPATIENCE"]);
    expect(feedback.violationLinkedTriggers.map(entry => entry.key)).toEqual(["FOMO"]);
    expect(feedback.nextAction).toBeTruthy();
  });

  it("composes the same summary whether it is called directly or through the adapter", () => {
    const input = { trades: [trade("2026-09-15")], plans: [{ planDate: "2026-09-15T08:00:00+05:00", behavioralObjectiveStatus: "YES" }] };
    const report = buildTraderDevelopment(input);
    const recomposed = withBehavioralFeedback(report, behaviorConfigFromProfile(null));
    expect(recomposed.behavioralFeedback).toEqual(report.behavioralFeedback);
  });

  it("merges the saved behavioural configuration over the documented defaults", () => {
    expect(behaviorConfigFromProfile(null)).toMatchObject({ maxTradesPerDay: null, cooldownAfterLosses: 2 });
    expect(behaviorConfigFromProfile({ behaviorConfig: { maxTradesPerDay: 3, maxRiskPerTrade: 50 } })).toMatchObject({ maxTradesPerDay: 3, maxRiskPerTrade: 50 });
    expect(behaviorConfigFromProfile({ behaviorConfig: { maxTradesPerDay: Number.NaN } }).maxTradesPerDay).toBeNull();
  });

  it("does not invent a behavioural review for a plan saved before the loop existed", () => {
    expect(planBehavioralReview({ planDate: "2025-01-05T08:00:00+05:00" })).toBeNull();
    expect(planBehavioralReview(undefined)).toBeNull();
    expect(planBehavioralReview({ planDate: "2026-09-15T08:00:00+05:00", postSessionBehavioralReview: { followPlan: "NO", nextSessionChange: "Wait" } })).toEqual({ followPlan: "NO", nextSessionChange: "Wait", triggerAction: "" });
  });
});
