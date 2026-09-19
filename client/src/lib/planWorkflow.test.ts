import { describe, expect, it } from "vitest";
import {
  PLAN_COPY_FIELDS,
  PLAN_RESET_FIELDS,
  copiedDraftFromPlan,
  copiedFieldDiff,
  copySourceOptions,
  dayKey,
  dayTrades,
  draftAsPlanSource,
  draftFromSavedPlan,
  emptyPlanDraft,
  findPreviousPlan,
  planSessionStatus,
  planVsExecution,
  tomorrowDraftFromPlan,
} from "./planWorkflow";

/**
 * The copy contract is the heart of the renewed plan workflow: yesterday's plan
 * is today's editable starting point, never a locked template, and never a
 * carrier for yesterday's results. These tests pin that contract down.
 */

const previousPlan = {
  id: 5,
  planDate: "2026-09-18T12:00:00+05:00",
  preBias: "Bullish",
  marketContext: "Asia range compressed under 3400",
  keyLevels: "3380 support / 3420 resistance",
  sessionFocus: ["London", "New York"],
  eventRisk: "CPI 13:30",
  longScenario: "Accept above 3400",
  shortScenario: "Reject 3420",
  noTradeCondition: "Thin liquidity before CPI",
  invalidationLevel: "Close below 3380",
  riskLimit: "200",
  maxTrades: 3,
  sizingPlan: "0.5R per A setup",
  planNotes: "One execution priority: patience at 3400",
  rulesPlanned: [{ id: "option-19", text: "Wait for London confirmation", checked: true }],
  behavioralFocus: "Wait for confirmation",
  psychologyRisk: "Impatience after a missed London entry",
  emotionalState: "Frustrated",
  energyLevel: 2,
  focusLevel: 2,
  confidenceLevel: 3,
  stressLevel: 4,
  emotionStart: "Frustrated",
  emotionEnd: "Calm",
  executionScore: 2,
  overallRating: 2,
  rulesFollowed: [{ id: "option-19", yes: false }],
  whatWentWell: "Respected the loss limit",
  whatWentWrong: "Chased the second entry",
  executionNotes: "Two entries, the second was late",
  planDeviation: "Entered before the confirmation close",
  lessons: "Wait for the confirmation close",
  tomorrowFocus: "Trade London only",
  psychologyTriggers: ["REVENGE", "FOMO"],
  primaryPsychologyTrigger: "REVENGE",
  behavioralObjectiveStatus: "NO",
  postSessionBehavioralReview: { followPlan: "NO", nextSessionChange: "Set the London alarm", triggerAction: "Chased a re-entry" },
};

describe("copying a previous plan", () => {
  it("copies the planning fields and resets every finished-session field", () => {
    const copied = copiedDraftFromPlan(previousPlan, "2026-09-19");

    for (const field of ["preBias", "marketContext", "keyLevels", "sessionFocus", "eventRisk", "longScenario", "shortScenario", "noTradeCondition", "invalidationLevel", "riskLimit", "maxTrades", "sizingPlan", "planNotes", "behavioralFocus", "psychologyRisk"]) {
      expect(PLAN_COPY_FIELDS).toContain(field as never);
    }
    expect(copied.preBias).toBe("Bullish");
    expect(copied.keyLevels).toBe("3380 support / 3420 resistance");
    expect(copied.sessionFocus).toEqual(["London", "New York"]);
    expect(copied.maxTrades).toBe("3");
    expect(copied.sizingPlan).toBe("0.5R per A setup");
    expect(copied.behavioralFocus).toBe("Wait for confirmation");
    expect(copied.rulesPlanned).toEqual([{ id: "option-19", text: "Wait for London confirmation", checked: true }]);

    const expectedResets = { emotionalState: "", emotionEnd: "", energyLevel: null, focusLevel: null, confidenceLevel: null, stressLevel: null, executionScore: null, overallRating: null, whatWentWell: "", whatWentWrong: "", executionNotes: "", planDeviation: "", lessons: "", tomorrowFocus: "", primaryPsychologyTrigger: "", behavioralObjectiveStatus: "", followPlan: "", nextSessionChange: "", triggerAction: "" };
    for (const [field, value] of Object.entries(expectedResets)) {
      expect(PLAN_RESET_FIELDS).toContain(field as never);
      expect((copied as Record<string, unknown>)[field]).toEqual(value);
    }
    expect(copied.rulesFollowed).toEqual([]);
    expect(copied.psychologyTriggers).toEqual([]);
  });

  it("records where the draft came from and stamps the new day", () => {
    const copied = copiedDraftFromPlan(previousPlan, "2026-09-19");
    expect(copied.day).toBe("2026-09-19");
    expect(copied.copiedFromPlanId).toBe(5);
    expect(copied.copiedFromPlanDay).toBe("2026-09-18");
  });

  it("never mutates the plan it copied", () => {
    const source = JSON.parse(JSON.stringify(previousPlan));
    const snapshot = JSON.stringify(source);
    const target = { ...previousPlan };
    const edited = copiedDraftFromPlan(target, "2026-09-19");
    edited.preBias = "Bearish";
    edited.rulesPlanned[0].checked = false;
    expect(JSON.stringify(target)).toBe(snapshot);
  });

  it("stays completely editable: every copied field can be changed and saved", () => {
    const copied = copiedDraftFromPlan(previousPlan, "2026-09-19");
    const edited = { ...copied, preBias: "Bearish", keyLevels: "3350", maxTrades: "1", riskLimit: "80", eventRisk: "FOMC", behavioralFocus: "Avoid revenge trading", rulesPlanned: copied.rulesPlanned.map(rule => ({ ...rule, checked: false })) };
    expect(edited.preBias).toBe("Bearish");
    expect(edited.rulesPlanned[0].checked).toBe(false);
    expect(edited.copiedFromPlanId).toBe(5);
  });

  it("promotes today's promised focus into tomorrow's objective", () => {
    const tomorrow = tomorrowDraftFromPlan(previousPlan, "2026-09-19");
    expect(tomorrow.behavioralFocus).toBe("Trade London only");
    expect(tomorrow.day).toBe("2026-09-19");
    expect(tomorrow.executionScore).toBeNull();
    expect(tomorrow.lessons).toBe("");
    expect(tomorrow.psychologyTriggers).toEqual([]);
  });

  it("copies from the draft itself when today has not been saved yet", () => {
    const draft = { ...emptyPlanDraft("2026-09-19"), preBias: "Bullish", tomorrowFocus: "Trade only A setups" };
    const source = draftAsPlanSource({ ...draft, rulesPlanned: [] }, Date.parse("2026-09-19T12:00:00+05:00"), 9);
    const tomorrow = tomorrowDraftFromPlan(source, "2026-09-20");
    expect(tomorrow.behavioralFocus).toBe("Trade only A setups");
    expect(tomorrow.copiedFromPlanId).toBe(9);
    expect(tomorrow.preBias).toBe("Bullish");
  });
});

describe("plan selection", () => {
  const plans = [
    { id: 1, planDate: "2026-09-15T12:00:00+05:00" },
    { id: 2, planDate: "2026-09-18T12:00:00+05:00" },
    { id: 3, planDate: "2026-09-17T12:00:00+05:00" },
  ];

  it("finds the most recent plan strictly before the target day", () => {
    expect(findPreviousPlan(plans, "2026-09-19")?.id).toBe(2);
    expect(findPreviousPlan(plans, "2026-09-16")?.id).toBe(1);
    expect(findPreviousPlan(plans, "2026-09-01")).toBeNull();
  });

  it("offers every other saved day as a copy source, excluding the day being edited", () => {
    const options = copySourceOptions(plans, "2026-09-18");
    expect(options.map(entry => entry.day)).toEqual(["2026-09-17", "2026-09-15"]);
    expect(copySourceOptions(plans).map(entry => entry.day)).toEqual(["2026-09-18", "2026-09-17", "2026-09-15"]);
  });

  it("handles Pakistan-time days, including the midnight boundary", () => {
    expect(dayKey("2026-09-18T20:00:00Z")).toBe("2026-09-19");
    expect(dayKey("2026-09-18T18:59:59Z")).toBe("2026-09-18");
    expect(dayKey(new Date(Date.parse("2026-09-18T12:00:00+05:00")))).toBe("2026-09-18");
    expect(dayKey("not a date")).toBe("");
  });
});

describe("smart copy difference", () => {
  it("reports only the planning fields the trader changed", () => {
    const source = copiedDraftFromPlan(previousPlan, "2026-09-19");
    const draft = { ...source, preBias: "Bearish", longScenario: "Reject 3420 only" };
    const diff = copiedFieldDiff(draft, source);
    expect(diff.find(entry => entry.key === "preBias")).toMatchObject({ label: "Bias", changed: true });
    expect(diff.find(entry => entry.key === "longScenario")?.changed).toBe(true);
    expect(diff.find(entry => entry.key === "keyLevels")?.changed).toBe(false);
    expect(diff.find(entry => entry.key === "riskLimit")?.changed).toBe(false);
  });
});

describe("session status", () => {
  const plan = { id: 1, planDate: "2026-09-19T12:00:00+05:00" };
  const closedTrade = { tradeDate: "2026-09-19T13:00:00+05:00", result: "LOSS", pnl: -50, session: "London" };
  const openTrade = { tradeDate: "2026-09-19T13:00:00+05:00", result: "OPEN", pnl: 0, session: "London" };

  it("starts at NOT STARTED with no plan and no trades", () => {
    expect(planSessionStatus({ plan: null, trades: [], day: "2026-09-19" }).key).toBe("NOT_STARTED");
  });

  it("moves to PLANNED once the plan is saved", () => {
    expect(planSessionStatus({ plan, trades: [], day: "2026-09-19" }).key).toBe("PLANNED");
  });

  it("stays IN PROGRESS while a position is open", () => {
    expect(planSessionStatus({ plan, trades: [openTrade], day: "2026-09-19" }).key).toBe("IN_PROGRESS");
  });

  it("asks for the review once the trades are closed", () => {
    expect(planSessionStatus({ plan, trades: [closedTrade], day: "2026-09-19" }).key).toBe("REVIEW_REQUIRED");
  });

  it("reaches REVIEWED only when the review was answered", () => {
    expect(planSessionStatus({ plan: { ...plan, behavioralObjectiveStatus: "PARTIALLY" }, trades: [closedTrade], day: "2026-09-19" }).key).toBe("REVIEWED");
    expect(planSessionStatus({ plan: { ...plan, lessons: "Wait for the close" }, trades: [closedTrade], day: "2026-09-19" }).key).toBe("REVIEWED");
    // The old scorecard alone still counts, so historic rows keep their state.
    expect(planSessionStatus({ plan: { ...plan, executionScore: 4 }, trades: [closedTrade], day: "2026-09-19" }).key).toBe("REVIEWED");
  });

  it("flags trades logged for a day with no plan instead of pretending it was planned", () => {
    const status = planSessionStatus({ plan: null, trades: [closedTrade], day: "2026-09-19" });
    expect(status.key).toBe("NOT_STARTED");
    expect(status.detail).toMatch(/without a saved plan/);
  });
});

describe("plan versus execution", () => {
  const plan = { id: 1, planDate: "2026-09-19T12:00:00+05:00", riskLimit: "200", maxTrades: 2, sessionFocus: ["London"], behavioralFocus: "Wait for confirmation", rulesPlanned: [{ id: "option-19", text: "Wait for London confirmation", checked: true }] };
  const trades = [
    { tradeDate: "2026-09-19T13:00:00+05:00", result: "WIN", pnl: 120, risk: 100, session: "London", planStatus: "PLANNED", setupQuality: "A", mistake: "" },
    { tradeDate: "2026-09-19T15:00:00+05:00", result: "LOSS", pnl: -100, risk: 100, session: "New York", planStatus: "UNPLANNED", setupQuality: "B", mistake: "FOMO" },
    { tradeDate: "2026-09-19T17:00:00+05:00", result: "LOSS", pnl: -60, risk: 100, session: "New York", planStatus: "PLANNED", setupQuality: "A", mistake: "Moved SL" },
  ];

  it("reports planned limits, actual behaviour, and the adherence percentage", () => {
    const execution = planVsExecution({ plan, trades, day: "2026-09-19" });
    expect(execution.planned).toMatchObject({ riskLimit: 200, maxTrades: 2, rules: 1, rulesApplied: 1 });
    expect(execution.planned.sessions).toEqual(["London"]);
    expect(execution.actual).toMatchObject({ trades: 3, open: 0, riskUsed: 300, unplanned: 1 });
    expect(execution.actual.violations).toBeGreaterThan(0);
    expect(execution.riskLimitRespected).toBe(false);
    expect(execution.maxTradesRespected).toBe(false);
    expect(execution.adherence).not.toBeNull();
    expect(execution.deviations.join(" ")).toMatch(/3 executed vs 2 planned/);
    expect(execution.deviations.join(" ")).toMatch(/1 unplanned entry/);
  });

  it("counts only the day's own trades", () => {
    const execution = planVsExecution({ plan, trades: [...trades, { tradeDate: "2026-09-18T13:00:00+05:00", result: "WIN", pnl: 999, risk: 50 }], day: "2026-09-19" });
    expect(execution.actual.trades).toBe(3);
    expect(execution.actual.riskUsed).toBe(300);
  });

  it("describes a possible behavioural deviation in neutral language", () => {
    const execution = planVsExecution({ plan, trades, day: "2026-09-19" });
    expect(execution.potentialBehaviouralDeviation).toMatch(/Potential behavioural deviation/);
    expect(execution.potentialBehaviouralDeviation).toMatch(/Wait for confirmation/);
    expect(execution.potentialBehaviouralDeviation).not.toMatch(/caused/);
  });

  it("says nothing about behaviour when there is no objective or no trade", () => {
    expect(planVsExecution({ plan: { ...plan, behavioralFocus: "" }, trades, day: "2026-09-19" }).potentialBehaviouralDeviation).toBeNull();
    expect(planVsExecution({ plan, trades: [], day: "2026-09-19" }).potentialBehaviouralDeviation).toBeNull();
  });

  it("never invents a review state", () => {
    expect(planVsExecution({ plan, trades, day: "2026-09-19" }).reviewSaved).toBe(false);
    expect(planVsExecution({ plan: { ...plan, behavioralObjectiveStatus: "YES" }, trades, day: "2026-09-19" }).reviewSaved).toBe(true);
  });

  it("keeps a clean session clean: respected limits produce a 100% adherence read", () => {
    const clean = [trades[0]];
    const execution = planVsExecution({ plan, trades: clean, day: "2026-09-19" });
    expect(execution.riskLimitRespected).toBe(true);
    expect(execution.maxTradesRespected).toBe(true);
    expect(execution.adherence).toBe(100);
    expect(execution.deviations).toEqual([]);
  });
});

describe("saved-plan loading", () => {
  it("keeps every stored value, including the historic ones", () => {
    const draft = draftFromSavedPlan(previousPlan, "2026-01-01");
    expect(draft.day).toBe("2026-09-18");
    expect(draft.lessons).toBe("Wait for the confirmation close");
    expect(draft.executionScore).toBe(2);
    expect(draft.psychologyTriggers).toEqual(["REVENGE", "FOMO"]);
    expect(draft.followPlan).toBe("NO");
    expect(draft.emotionEnd).toBe("Calm");
    expect(draft.rulesFollowed).toEqual([{ id: "option-19", yes: false }]);
  });

  it("tolerates a plan saved before these fields existed", () => {
    const legacy = { id: 2, planDate: "2025-01-05T12:00:00+05:00", preBias: "Neutral", rulesPlanned: [], rulesFollowed: [] };
    const draft = draftFromSavedPlan(legacy, "2025-01-05");
    expect(draft.emotionalState).toBe("");
    expect(draft.psychologyTriggers).toEqual([]);
    expect(draft.behavioralObjectiveStatus).toBe("");
    expect(draft.followPlan).toBe("");
    expect(draft.copiedFromPlanId).toBeNull();
  });

  it("splits pipe-joined historic emotion text instead of losing it", () => {
    const draft = draftFromSavedPlan({ id: 3, planDate: "2025-02-05T12:00:00+05:00", emotionEnd: "Disciplined|Calm" }, "2025-02-05");
    expect(draft.emotionEnd).toBe("Disciplined");
  });

  it("returns an empty draft for a day that was never planned", () => {
    expect(draftFromSavedPlan(null, "2026-09-19")).toEqual(emptyPlanDraft("2026-09-19"));
  });
});

describe("day trades", () => {
  it("groups by Pakistan-time day and keeps chronological order", () => {
    const trades = [
      { id: 2, tradeDate: "2026-09-19T18:00:00+05:00" },
      { id: 1, tradeDate: "2026-09-19T11:00:00+05:00" },
      { id: 3, tradeDate: "2026-09-18T22:00:00+05:00" },
    ];
    expect(dayTrades(trades, "2026-09-19").map(trade => trade.id)).toEqual([1, 2]);
    expect(dayTrades(trades, "2026-09-18").map(trade => trade.id)).toEqual([3]);
  });
});
