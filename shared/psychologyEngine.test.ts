import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCIPLINE_WEIGHTS,
  MISTAKE_TAXONOMY,
  analyzeTraderDevelopment,
  buildTraderSessions,
  calculateBehavioralFocus,
  calculateBehavioralPnl,
  calculateDisciplineScore,
  calculateIdentityConsistency,
  calculatePlanAdherence,
  calculateStreaks,
  calculateTradingReadiness,
  calculateWeeklyPsychology,
  classifyTradeProcess,
  detectBehavioralTags,
  detectDuplicateTickets,
  evaluateCooldown,
  evaluatePreTradeGate,
  groupTradingSessions,
  type PsychologyPlan,
  type PsychologyTrade,
  type TraderSession,
} from "./psychologyEngine";

/* ------------------------------------------------------------------ *
 * Fixtures: two Pakistan-time sessions, one disciplined, one not.
 * ------------------------------------------------------------------ */

const bookPlan: PsychologyPlan = {
  id: 1,
  planDate: "2026-08-03T08:00:00+05:00",
  riskLimit: "200",
  maxTrades: 2,
  sessionFocus: ["London"],
  executionScore: 4,
  overallRating: 4,
  behavioralFocus: "Patience",
  emotionalState: "Calm",
  lessons: "Waited for the confirmation close.",
  rulesPlanned: [{ id: "r1", text: "Wait for London confirmation", checked: true }],
  rulesFollowed: [{ id: "r1", yes: true }],
  whatWentWrong: "Nothing material.",
};

const revengePlan: PsychologyPlan = {
  id: 2,
  planDate: "2026-08-04T08:00:00+05:00",
  riskLimit: "200",
  maxTrades: 2,
  sessionFocus: ["London"],
  emotionalState: "Frustrated",
  behavioralFocus: "Risk discipline",
};

const disciplinedTrades: PsychologyTrade[] = [
  { id: 1, tradeDate: "2026-08-03T11:00:00+05:00", result: "WIN", pnl: 200, risk: 100, reward: 200, setupQuality: "A+", session: "London", planStatus: "PLANNED", patienceScore: 5, holdQuality: "Excellent", mistake: "" },
  { id: 2, tradeDate: "2026-08-03T14:00:00+05:00", result: "LOSS", pnl: -100, risk: 100, reward: 200, setupQuality: "A", session: "London", planStatus: "PLANNED", patienceScore: 4, holdQuality: "Good", mistake: "None" },
];

const brokenTrades: PsychologyTrade[] = [
  { id: 3, tradeDate: "2026-08-04T11:00:00+05:00", result: "LOSS", pnl: -250, risk: 150, reward: 300, setupQuality: "B", session: "New York", planStatus: "UNPLANNED", patienceScore: 2, holdQuality: "Poor", mistake: "Moved SL | FOMO" },
  { id: 4, tradeDate: "2026-08-04T13:00:00+05:00", result: "WIN", pnl: 120, risk: 100, reward: 200, setupQuality: "A", session: "New York", planStatus: "UNPLANNED", patienceScore: 4, holdQuality: "Good", mistake: "FOMO" },
  { id: 5, tradeDate: "2026-08-04T15:00:00+05:00", result: "LOSS", pnl: -80, risk: 100, reward: 200, setupQuality: "A", session: "London", planStatus: "PLANNED", patienceScore: 5, holdQuality: "Excellent", mistake: "" },
];

const allTrades = [...disciplinedTrades, ...brokenTrades];
const allPlans = [bookPlan, revengePlan];

const assessmentFor = (trade: PsychologyTrade, context = {}) => classifyTradeProcess(trade, context);

describe("behavioural mistake taxonomy", () => {
  it("maps historic tag spellings onto the taxonomy without inventing tags", () => {
    const detected = detectBehavioralTags("Over-risked | closed early | chase | Moved SL");
    expect(detected.tags).toEqual(expect.arrayContaining(["OVERSIZED", "EARLY_EXIT", "FOMO", "MOVED_SL"]));
    expect(detected.unknown).toEqual([]);
  });

  it("treats none / empty as no tag and keeps unknown tags visible", () => {
    expect(detectBehavioralTags("None").tags).toEqual([]);
    expect(detectBehavioralTags("").tags).toEqual([]);
    expect(detectBehavioralTags("My own note").unknown).toEqual(["My own note"]);
  });

  it("covers every requested category with a stable label", () => {
    const categories = new Set(MISTAKE_TAXONOMY.map(item => item.category));
    expect(categories).toEqual(new Set(["EMOTIONAL", "EXECUTION", "ANALYTICAL", "ENVIRONMENTAL"]));
    for (const item of MISTAKE_TAXONOMY) expect(item.label.length).toBeGreaterThan(1);
  });
});

describe("trade process classification", () => {
  it("classifies a good win", () => {
    const result = assessmentFor({ tradeDate: "2026-08-04T10:00:00+05:00", result: "WIN", pnl: 150, risk: 50, setupQuality: "A", planStatus: "PLANNED", patienceScore: 5, holdQuality: "Good", mistake: "" });
    expect(result.classification).toBe("GOOD_WIN");
    expect(result.processCompliant).toBe(true);
  });

  it("classifies a bad win and keeps the profit visible", () => {
    const result = assessmentFor({ tradeDate: "2026-08-04T10:00:00+05:00", result: "WIN", pnl: 300, risk: 50, setupQuality: "A", mistake: "FOMO", planStatus: "PLANNED" });
    expect(result.classification).toBe("BAD_WIN");
    expect(result.processCompliant).toBe(false);
    expect(result.violations).toContain("FOMO");
  });

  it("classifies a good loss without treating the outcome as failure", () => {
    const result = assessmentFor({ tradeDate: "2026-08-04T10:00:00+05:00", result: "LOSS", pnl: -80, risk: 50, setupQuality: "A", planStatus: "PLANNED", patienceScore: 5, holdQuality: "Excellent", mistake: "" });
    expect(result.classification).toBe("GOOD_LOSS");
    expect(result.processCompliant).toBe(true);
  });

  it("classifies a bad loss and names the saved reason", () => {
    const result = assessmentFor({ tradeDate: "2026-08-04T10:00:00+05:00", result: "LOSS", pnl: -80, risk: 50, setupQuality: "B", mistake: "Revenge", planStatus: "UNPLANNED" });
    expect(result.classification).toBe("BAD_LOSS");
    expect(result.reasons.join(" ")).toMatch(/Revenge|Setup quality|not part of the plan/);
  });

  it("marks raw MT5 rows as not evaluated instead of inventing values", () => {
    const result = assessmentFor({ tradeDate: "2026-08-04T10:00:00+05:00", result: "WIN", pnl: 75, mt5Ticket: "9001" });
    expect(result.classification).toBe("NOT_EVALUATED");
    expect(result.processCompliant).toBeNull();
    expect(result.ruleAdherence).toBeNull();
  });

  it("counts an over-limit position as a bad process even without a tag", () => {
    const result = assessmentFor({ tradeDate: "2026-08-04T10:00:00+05:00", result: "WIN", pnl: 90, risk: 200, setupQuality: "A", planStatus: "PLANNED" }, { riskCeiling: 100 });
    expect(result.classification).toBe("BAD_WIN");
    expect(result.riskAdherence).toBe(0);
  });

  it("reads the pre-trade gate when it was saved", () => {
    const result = assessmentFor({
      tradeDate: "2026-08-04T10:00:00+05:00", result: "WIN", pnl: 50, setupQuality: "A", planStatus: "PLANNED",
      planChecklist: [{ id: "stop-defined", checked: true }, { id: "risk-in-limit", checked: true }, { id: "rr-acceptable", checked: false }],
    });
    expect(result.ruleAdherence).toBeCloseTo(88.9, 1);
    expect(result.processCompliant).toBe(false);
    expect(result.classification).toBe("BAD_WIN");
  });

  it("scores the pre-trade gate deterministically", () => {
    expect(evaluatePreTradeGate([{ id: "a", checked: true }, { id: "b", checked: false }])).toMatchObject({ answered: 2, passed: 1, score: 50 });
    expect(evaluatePreTradeGate(undefined).score).toBeNull();
  });
});

describe("plan adherence and risk adherence", () => {
  it("compares planned and actual execution for a session", () => {
    const adherence = calculatePlanAdherence(revengePlan, brokenTrades);
    expect(adherence.plannedTrades).toBe(2);
    expect(adherence.actualTrades).toBe(3);
    expect(adherence.plannedRisk).toBe(200);
    expect(adherence.actualRisk).toBe(350);
    expect(adherence.unplannedTrades).toBe(2);
    expect(adherence.adherence).toBeCloseTo(41.7, 1);
    expect(adherence.notes.join(" ")).toMatch(/3 executed vs 2 planned/);
  });

  it("scores a fully followed plan at 100", () => {
    expect(calculatePlanAdherence(bookPlan, disciplinedTrades).adherence).toBe(100);
  });

  it("keeps an empty session undefined instead of zero", () => {
    const adherence = calculatePlanAdherence(null, []);
    expect(adherence.adherence).toBeNull();
  });
});

describe("discipline score", () => {
  const components = (overrides: Partial<Record<keyof typeof DEFAULT_DISCIPLINE_WEIGHTS, number | null>> = {}) => {
    const base = { score: 100, sample: 1, violations: 0 };
    const build = (key: keyof typeof DEFAULT_DISCIPLINE_WEIGHTS) => (overrides[key] === undefined ? base : overrides[key] === null ? { score: null, sample: 0, violations: 0 } : { score: overrides[key] as number, sample: 1, violations: 0 });
    return { risk: build("risk"), plan: build("plan"), setup: build("setup"), execution: build("execution"), overtrading: build("overtrading"), journal: build("journal"), psychology: build("psychology") };
  };

  it("uses the documented weighted model", () => {
    const score = calculateDisciplineScore(components());
    expect(score.score).toBe(100);
    expect(score.breakdown.find(entry => entry.key === "risk")?.effectiveWeight).toBe(25);
    expect(score.breakdown.find(entry => entry.key === "plan")?.effectiveWeight).toBe(20);
  });

  it("excludes components without data and renormalises the weights", () => {
    const withGap = calculateDisciplineScore(components({ risk: null, plan: 50 }));
    const evaluable = withGap.breakdown.filter(entry => entry.value != null);
    expect(evaluable.reduce((sum, entry) => sum + entry.effectiveWeight, 0)).toBeCloseTo(100, 0);
    expect(withGap.note).toMatch(/renormalised/);
  });

  it("accepts a configurable weighting", () => {
    const tuple = calculateDisciplineScore(components({ risk: 40, plan: 90 }), { risk: 100, plan: 0, setup: 0, execution: 0, overtrading: 0, journal: 0, psychology: 0 });
    expect(tuple.score).toBe(40);
  });
});

describe("behavioural P&L", () => {
  it("separates compliant profit from rule-violation profit without touching P&L", () => {
    const result = calculateBehavioralPnl(allTrades, allPlans);
    const naiveTotal = allTrades.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0);
    expect(result.totalPnl).toBe(naiveTotal);
    expect(result.totalPnl).toBe(-110);
    expect(result.processCompliantPnl).toBe(20);
    expect(result.ruleViolationPnl).toBe(-130);
    expect(result.complianceRate).toBe(60);
    expect(result.note).toMatch(/never changes the account P&L/i);
  });

  it("reports MT5 imports separately and never invents a compliance rate", () => {
    const result = calculateBehavioralPnl([{ tradeDate: "2026-08-04T10:00:00+05:00", result: "WIN", pnl: 75, mt5Ticket: "9001" }], []);
    expect(result.notEvaluated).toBe(1);
    expect(result.notEvaluatedPnl).toBe(75);
    expect(result.complianceRate).toBeNull();
  });
});

describe("discipline streaks", () => {
  it("breaks a streak at the most recent failing session", () => {
    const sessions = buildTraderSessions(allTrades, allPlans);
    const streaks = calculateStreaks(sessions);
    expect(streaks.risk).toBe(0);
    expect(streaks.noFomo).toBe(0);
    expect(streaks.planAdherence).toBe(0);
    expect(streaks.noOvertrading).toBe(0);
    expect(streaks.journal).toBe(0);
    // Day two recorded no revenge tag, so the no-revenge streak spans both sessions.
    expect(streaks.noRevenge).toBe(2);
    expect(streaks.riskLabel).toMatch(/without breaking risk rules/);
  });

  it("keeps a clean streak alive", () => {
    const sessions: TraderSession[] = buildTraderSessions(disciplinedTrades, [bookPlan]);
    const streaks = calculateStreaks(sessions);
    expect(streaks.risk).toBe(1);
    expect(streaks.noFomo).toBe(1);
    expect(streaks.journal).toBe(1);
  });
});

describe("behavioural focus and weekly psychology", () => {
  it("identifies the weakest recurring behaviour from real tags", () => {
    const focus = calculateBehavioralFocus(buildTraderSessions(allTrades, allPlans));
    expect(focus?.key).toBe("FOMO");
    expect(focus?.score).toBe(50);
    expect(focus?.target).toBeGreaterThan(50);
    expect(focus?.recommendation).toMatch(/confirmation/);
  });

  it("returns null focus when nothing has been journalled", () => {
    expect(calculateBehavioralFocus([])).toBeNull();
  });

  it("builds the weekly psychology report from the window", () => {
    const weekly = calculateWeeklyPsychology(buildTraderSessions(allTrades, allPlans));
    expect(weekly.sessions).toBe(2);
    expect(weekly.discipline).toBeCloseTo(74.9, 1);
    expect(weekly.fomo).toBe(50);
    expect(weekly.revenge).toBe(100);
    expect(weekly.overtrading).toBe(50);
    expect(weekly.riskDiscipline).toBe(83.4);
    expect(weekly.biggestWeakness?.value).toBe(50);
    expect(weekly.nextWeekFocus).toMatch(/confirmation/);
    expect(weekly.observed.some(line => /2 sessions reviewed/.test(line))).toBe(true);
    expect(weekly.observed.some(line => /at least one behavioural rule break/.test(line))).toBe(true);
  });

  it("keeps observed facts separate from interpretation", () => {
    const report = analyzeTraderDevelopment({ trades: allTrades, plans: allPlans });
    expect(report.insights.some(entry => entry.kind === "OBSERVED" && /unplanned/.test(entry.text))).toBe(true);
    for (const entry of report.insights) expect(["OBSERVED", "INTERPRETATION"]).toContain(entry.kind);
  });
});

describe("readiness, cooldown and identity", () => {
  it("scores a calm check-in as ready", () => {
    const readiness = calculateTradingReadiness({ emotionalState: "Calm", energyLevel: 4, focusLevel: 5, confidenceLevel: 4, stressLevel: 2 });
    expect(readiness.score).toBeCloseTo(88, 0);
    expect(readiness.band).toBe("HIGH");
  });

  it("guides instead of blocking when readiness is low", () => {
    const readiness = calculateTradingReadiness({ emotionalState: "Tired", energyLevel: 1, focusLevel: 1, confidenceLevel: 3, stressLevel: 5 });
    expect(readiness.band).toBe("LOW");
    expect(readiness.guidance).toMatch(/reducing size|wait for a high-quality setup/i);
  });

  it("treats a missing check-in as unknown, not as failure", () => {
    expect(calculateTradingReadiness(null)).toMatchObject({ score: null, band: "UNKNOWN" });
  });

  it("raises a cooldown after consecutive losses and completes the session at the daily loss limit", () => {
    const sessions = buildTraderSessions(allTrades, allPlans);
    expect(evaluateCooldown(sessions).status).toBe("CLEAR");
    expect(evaluateCooldown(sessions, { cooldownAfterLosses: 1 }).status).toBe("COOLDOWN");
    expect(evaluateCooldown(sessions, { cooldownAfterLosses: 1 }).actions).toHaveLength(4);
    const complete = evaluateCooldown(sessions, { maxDailyLoss: 100 });
    expect(complete.status).toBe("SESSION_COMPLETE");
    expect(complete.message).toMatch(/no longer recovery/);
  });

  it("evaluates identity consistency against saved behaviour", () => {
    const identity = calculateIdentityConsistency("I follow the plan even when the outcome is uncomfortable.", buildTraderSessions(allTrades, allPlans));
    expect(identity.score).not.toBeNull();
    expect(identity.checks.map(check => check.label)).toContain("Accepted valid losses");
  });

  it("returns no identity score when no statement is saved", () => {
    expect(calculateIdentityConsistency("", []).score).toBeNull();
  });
});

describe("composition and edge cases", () => {
  it("aggregates the trader development report", () => {
    const report = analyzeTraderDevelopment({ trades: allTrades, plans: allPlans });
    expect(report.sessions).toHaveLength(2);
    expect(report.totals).toMatchObject({ sessions: 2, trades: 5, unplanned: 2, reviewed: 1 });
    expect(report.counts).toMatchObject({ GOOD_WIN: 1, BAD_WIN: 1, GOOD_LOSS: 2, BAD_LOSS: 1, NOT_EVALUATED: 0 });
    expect(report.discipline.score).toBeCloseTo(71.5, 1);
    expect(report.discipline.breakdown.find(entry => entry.key === "risk")?.value).toBe(80);
    expect(report.discipline.breakdown.find(entry => entry.key === "psychology")?.value).toBe(50);
    expect(report.today?.day).toBe("2026-08-04");
  });

  it("handles zero trades without inventing scores", () => {
    const report = analyzeTraderDevelopment({ trades: [] });
    expect(report.discipline.score).toBeNull();
    expect(report.focus).toBeNull();
    expect(report.behavioralPnl).toMatchObject({ totalPnl: 0, complianceRate: null });
    expect(report.readiness.band).toBe("UNKNOWN");
    expect(report.cooldown.status).toBe("CLEAR");
    expect(report.counts).toEqual({ GOOD_WIN: 0, BAD_WIN: 0, GOOD_LOSS: 0, BAD_LOSS: 0, NOT_EVALUATED: 0 });
  });

  it("handles a single trade and a missing plan", () => {
    const report = analyzeTraderDevelopment({ trades: [disciplinedTrades[0]] });
    expect(report.sessions).toHaveLength(1);
    expect(report.behavioralPnl.totalPnl).toBe(200);
    expect(report.discipline.breakdown.find(entry => entry.key === "journal")?.value).toBeNull();
    expect(report.sessions[0].planAdherence.adherence).toBeNull();
    expect(report.sessions[0].classificationCounts.GOOD_WIN).toBe(1);
  });

  it("falls back to the configured per-trade ceiling for a partial plan", () => {
    const partial: PsychologyPlan = { planDate: "2026-08-04T08:00:00+05:00", riskLimit: "300" };
    const [session] = buildTraderSessions([brokenTrades[0]], [partial], { maxRiskPerTrade: 100 });
    expect(session.assessments[0].riskAdherence).toBe(50);
  });

  it("groups sessions by the Pakistan-time day, including midnight boundaries", () => {
    const grouped = groupTradingSessions([
      { tradeDate: "2026-08-04T18:59:59Z", result: "WIN", pnl: 1 },
      { tradeDate: "2026-08-04T20:00:00Z", result: "WIN", pnl: 1 },
    ]);
    expect(grouped.map(entry => entry.day)).toEqual(["2026-08-04", "2026-08-05"]);
  });

  it("flags duplicate MT5 rows instead of silently dropping P&L", () => {
    const notes = detectDuplicateTickets([{ tradeDate: "2026-08-04T10:00:00+05:00", mt5Ticket: "77", pnl: 10 }, { tradeDate: "2026-08-04T11:00:00+05:00", mt5Ticket: "77", pnl: 20 }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/ticket 77 appears 2 times/);
    expect(calculateBehavioralPnl([{ tradeDate: "2026-08-04T10:00:00+05:00", mt5Ticket: "77", result: "WIN", pnl: 10 }, { tradeDate: "2026-08-04T11:00:00+05:00", mt5Ticket: "77", result: "WIN", pnl: 20 }]).totalPnl).toBe(30);
  });

  it("never mutates the trade rows it reads", () => {
    const trade = { ...disciplinedTrades[0] };
    const snapshot = JSON.stringify(trade);
    analyzeTraderDevelopment({ trades: [trade], plans: [bookPlan] });
    expect(JSON.stringify(trade)).toBe(snapshot);
  });
});
