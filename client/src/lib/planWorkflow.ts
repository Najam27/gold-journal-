/**
 * The Plan & Execution workflow model.
 *
 * Everything here is pure: the plan editor renders from these functions and the
 * tests drive them directly, so "copy from a previous day" can be proven to
 * reset the right fields, never mutate its source, and never invent a value a
 * trader did not save.
 *
 * The copy contract, in one place:
 *   • COPY the planning fields (market, scenarios, risk, rules, thesis, and the
 *     behavioural objective as a starting point);
 *   • RESET every field that describes a finished session — emotional
 *     measurements, scores, rule adherence, review text, triggers, and the
 *     objective verdict. Those belong to the day that produced them.
 */

import { getPktDateKey } from "@shared/pktDate";
import {
  buildTraderSessions,
  hasSessionReview,
  parseBehavioralObjectiveStatus,
  parsePostSessionBehavioralReview,
  parsePsychologyTriggers,
  type BehaviorConfig,
  type PsychologyPlan,
  type PsychologyTrade,
  type TradeClassification,
} from "@shared/psychologyEngine";

export type PlanRule = { id: string; text: string; checked: boolean };
export type PlanRuleOutcome = { id: string; yes: boolean };
export type Verdict = "" | "YES" | "PARTIALLY" | "NO";

/** The editable shape of one session: planning first, review after the close. */
export type PlanDraft = {
  /** Pakistan-time calendar day, `YYYY-MM-DD`. */
  day: string;
  preBias: string;
  marketContext: string;
  keyLevels: string;
  sessionFocus: string[];
  eventRisk: string;
  longScenario: string;
  shortScenario: string;
  noTradeCondition: string;
  invalidationLevel: string;
  riskLimit: string;
  maxTrades: string;
  sizingPlan: string;
  planNotes: string;
  rulesPlanned: PlanRule[];
  emotionalState: string;
  energyLevel: number | null;
  focusLevel: number | null;
  confidenceLevel: number | null;
  stressLevel: number | null;
  behavioralFocus: string;
  psychologyRisk: string;
  emotionEnd: string;
  executionScore: number | null;
  overallRating: number | null;
  rulesFollowed: PlanRuleOutcome[];
  whatWentWell: string;
  whatWentWrong: string;
  executionNotes: string;
  planDeviation: string;
  lessons: string;
  tomorrowFocus: string;
  psychologyTriggers: string[];
  primaryPsychologyTrigger: string;
  behavioralObjectiveStatus: Verdict;
  followPlan: Verdict;
  nextSessionChange: string;
  triggerAction: string;
  /** Set when this draft was copied; provenance, never a template. */
  copiedFromPlanId: number | null;
  copiedFromPlanDay: string | null;
};

/** Planning fields a copy carries over. Read by the UI and the tests. */
export const PLAN_COPY_FIELDS = [
  "marketContext",
  "preBias",
  "keyLevels",
  "sessionFocus",
  "eventRisk",
  "longScenario",
  "shortScenario",
  "noTradeCondition",
  "invalidationLevel",
  "riskLimit",
  "maxTrades",
  "sizingPlan",
  "planNotes",
  "rulesPlanned",
  "behavioralFocus",
  "psychologyRisk",
] as const;

/** Fields a copy always resets, because they describe the finished session. */
export const PLAN_RESET_FIELDS = [
  "emotionalState",
  "energyLevel",
  "focusLevel",
  "confidenceLevel",
  "stressLevel",
  "emotionEnd",
  "executionScore",
  "overallRating",
  "rulesFollowed",
  "whatWentWell",
  "whatWentWrong",
  "executionNotes",
  "planDeviation",
  "lessons",
  "tomorrowFocus",
  "psychologyTriggers",
  "primaryPsychologyTrigger",
  "behavioralObjectiveStatus",
  "followPlan",
  "nextSessionChange",
  "triggerAction",
] as const;

/** Human labels for the smart-copy difference list. */
export const PLAN_FIELD_LABELS: Record<string, string> = {
  preBias: "Bias",
  keyLevels: "Key levels",
  eventRisk: "Event risk",
  sessionFocus: "Session focus",
  longScenario: "Long scenario",
  shortScenario: "Short scenario",
  noTradeCondition: "No-trade condition",
  invalidationLevel: "Bias invalidation",
  riskLimit: "Risk limit",
  maxTrades: "Max trades",
  sizingPlan: "Position sizing",
  planNotes: "Session thesis",
  marketContext: "Market context",
  rulesPlanned: "Rules",
  behavioralFocus: "Behavioural focus",
};

export const dayKey = (value: unknown): string => getPktDateKey(value as never) || "";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rules(value: unknown): PlanRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      const item = entry as { id?: unknown; text?: unknown; checked?: unknown };
      const text = clean(item.text ?? (entry as { label?: unknown }).label);
      if (!text) return null;
      return { id: clean(item.id) || `rule-${index}`, text, checked: item.checked !== false };
    })
    .filter((entry): entry is PlanRule => entry !== null);
}

function ruleOutcomes(value: unknown): PlanRuleOutcome[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(entry => {
      const item = entry as { id?: unknown; yes?: unknown };
      const id = clean(item.id);
      return id ? { id, yes: item.yes === true } : null;
    })
    .filter((entry): entry is PlanRuleOutcome => entry !== null);
}

/** Emotion text is stored pipe-joined (or as a historic comma list). */
function firstEmotion(value: unknown): string {
  const text = clean(value);
  if (!text) return "";
  return text.split("|")[0].split(",")[0].trim();
}

export function emptyPlanDraft(day: string): PlanDraft {
  return {
    day,
    preBias: "Neutral",
    marketContext: "",
    keyLevels: "",
    sessionFocus: [],
    eventRisk: "",
    longScenario: "",
    shortScenario: "",
    noTradeCondition: "",
    invalidationLevel: "",
    riskLimit: "",
    maxTrades: "",
    sizingPlan: "",
    planNotes: "",
    rulesPlanned: [],
    emotionalState: "",
    energyLevel: null,
    focusLevel: null,
    confidenceLevel: null,
    stressLevel: null,
    behavioralFocus: "",
    psychologyRisk: "",
    emotionEnd: "",
    executionScore: null,
    overallRating: null,
    rulesFollowed: [],
    whatWentWell: "",
    whatWentWrong: "",
    executionNotes: "",
    planDeviation: "",
    lessons: "",
    tomorrowFocus: "",
    psychologyTriggers: [],
    primaryPsychologyTrigger: "",
    behavioralObjectiveStatus: "",
    followPlan: "",
    nextSessionChange: "",
    triggerAction: "",
    copiedFromPlanId: null,
    copiedFromPlanDay: null,
  };
}

/**
 * Loads a saved plan into the editor, results included. This is what the trader
 * sees when they open a day they already reviewed: nothing is hidden or lost.
 */
export function draftFromSavedPlan(plan: Record<string, unknown> | null | undefined, fallbackDay: string): PlanDraft {
  const draft = emptyPlanDraft(fallbackDay);
  if (!plan) return draft;
  const review = parsePostSessionBehavioralReview(plan.postSessionBehavioralReview);
  return {
    ...draft,
    day: dayKey(plan.planDate) || fallbackDay,
    preBias: clean(plan.preBias) || "Neutral",
    marketContext: clean(plan.marketContext),
    keyLevels: clean(plan.keyLevels),
    sessionFocus: Array.isArray(plan.sessionFocus) ? (plan.sessionFocus as unknown[]).map(value => clean(value)).filter(Boolean) : [],
    eventRisk: clean(plan.eventRisk),
    longScenario: clean(plan.longScenario),
    shortScenario: clean(plan.shortScenario),
    noTradeCondition: clean(plan.noTradeCondition),
    invalidationLevel: clean(plan.invalidationLevel),
    riskLimit: clean(plan.riskLimit),
    maxTrades: plan.maxTrades == null ? "" : String(plan.maxTrades),
    sizingPlan: clean(plan.sizingPlan),
    planNotes: clean(plan.planNotes),
    rulesPlanned: rules(plan.rulesPlanned),
    emotionalState: clean(plan.emotionalState),
    energyLevel: numberOrNull(plan.energyLevel),
    focusLevel: numberOrNull(plan.focusLevel),
    confidenceLevel: numberOrNull(plan.confidenceLevel),
    stressLevel: numberOrNull(plan.stressLevel),
    behavioralFocus: clean(plan.behavioralFocus),
    psychologyRisk: clean(plan.psychologyRisk),
    emotionEnd: firstEmotion(plan.emotionEnd),
    executionScore: numberOrNull(plan.executionScore),
    overallRating: numberOrNull(plan.overallRating),
    rulesFollowed: ruleOutcomes(plan.rulesFollowed),
    whatWentWell: clean(plan.whatWentWell),
    whatWentWrong: clean(plan.whatWentWrong),
    executionNotes: clean(plan.executionNotes),
    planDeviation: clean(plan.planDeviation),
    lessons: clean(plan.lessons),
    tomorrowFocus: clean(plan.tomorrowFocus),
    psychologyTriggers: parsePsychologyTriggers(plan.psychologyTriggers),
    primaryPsychologyTrigger: clean(plan.primaryPsychologyTrigger),
    behavioralObjectiveStatus: parseBehavioralObjectiveStatus(plan.behavioralObjectiveStatus) ?? "",
    followPlan: review?.followPlan ?? "",
    nextSessionChange: review?.nextSessionChange ?? "",
    triggerAction: review?.triggerAction ?? "",
    copiedFromPlanId: numberOrNull(plan.copiedFromPlanId),
    copiedFromPlanDay: dayKey(plan.copiedFromPlanDate) || null,
  };
}

/**
 * Builds today's editable starting point from an earlier session.
 *
 * The source object is only read. Planning fields carry over, every result and
 * measurement resets, and the day itself becomes the draft's own day — so the
 * source row can never be written to and today never inherits yesterday's
 * verdicts.
 */
export function copiedDraftFromPlan(source: Record<string, unknown>, day: string): PlanDraft {
  const copied = draftFromSavedPlan(source, day);
  const reset = emptyPlanDraft(day);
  return {
    ...reset,
    // Planning fields only.
    preBias: copied.preBias,
    marketContext: copied.marketContext,
    keyLevels: copied.keyLevels,
    sessionFocus: copied.sessionFocus,
    eventRisk: copied.eventRisk,
    longScenario: copied.longScenario,
    shortScenario: copied.shortScenario,
    noTradeCondition: copied.noTradeCondition,
    invalidationLevel: copied.invalidationLevel,
    riskLimit: copied.riskLimit,
    maxTrades: copied.maxTrades,
    sizingPlan: copied.sizingPlan,
    planNotes: copied.planNotes,
    rulesPlanned: copied.rulesPlanned.map(rule => ({ ...rule })),
    // The objective and the psychological risk note travel as a starting point;
    // the check-in measurements and every review field stay reset above.
    behavioralFocus: copied.behavioralFocus,
    psychologyRisk: copied.psychologyRisk,
    copiedFromPlanId: numberOrNull(source.id),
    copiedFromPlanDay: dayKey(source.planDate) || null,
  };
}

/**
 * Tomorrow's draft: the stable planning structure and today's rules, with
 * today's promised focus promoted to the new behavioural objective. No
 * measurement and no review value is carried across.
 */
export function tomorrowDraftFromPlan(source: Record<string, unknown>, day: string): PlanDraft {
  const copied = copiedDraftFromPlan(source, day);
  return { ...copied, behavioralFocus: clean(source.tomorrowFocus) || "" };
}

/** The most recent saved plan strictly before `day`. */
export function findPreviousPlan<T extends Record<string, unknown>>(plans: T[], day: string): T | null {
  return (
    plans
      .filter(plan => {
        const key = dayKey(plan.planDate);
        return key && key < day;
      })
      .sort((a, b) => dayKey(b.planDate).localeCompare(dayKey(a.planDate)))[0] ?? null
  );
}

/** Every saved plan that can be copied, newest first, one entry per day. */
export function copySourceOptions<T extends Record<string, unknown>>(plans: T[], excludeDay?: string) {
  const seen = new Set<string>();
  return plans
    .map(plan => ({ plan, day: dayKey(plan.planDate) }))
    .filter(entry => entry.day && entry.day !== excludeDay && !seen.has(entry.day) && (seen.add(entry.day), true))
    .sort((a, b) => b.day.localeCompare(a.day));
}

/** Which copied planning fields the trader has changed since the copy. */
export function copiedFieldDiff(draft: PlanDraft, source: PlanDraft) {
  return (PLAN_COPY_FIELDS as readonly string[])
    .map(key => key in PLAN_FIELD_LABELS ? key : null)
    .filter((key): key is string => key !== null)
    .map(key => ({
      key,
      label: PLAN_FIELD_LABELS[key],
      changed: JSON.stringify(draft[key as keyof PlanDraft] ?? null) !== JSON.stringify(source[key as keyof PlanDraft] ?? null),
    }));
}

export type SessionStatusKey = "NOT_STARTED" | "PLANNED" | "IN_PROGRESS" | "REVIEW_REQUIRED" | "REVIEWED";

export type SessionStatus = {
  key: SessionStatusKey;
  label: string;
  tone: "neutral" | "safe" | "watch" | "risk";
  detail: string;
};

export type PlanTrade = Record<string, unknown>;

/** The account's saved trades for one Pakistan-time day, oldest first. */
export function dayTrades<T extends PlanTrade>(trades: T[], day: string): T[] {
  return trades
    .filter(trade => dayKey(trade.tradeDate) === day)
    .sort((a, b) => new Date(a.tradeDate as string).getTime() - new Date(b.tradeDate as string).getTime());
}

export const isOpenTrade = (trade: PlanTrade) => clean(trade.result).toUpperCase() === "OPEN";

/**
 * One of five honest states. Nothing here is invented: a day only reaches
 * REVIEWED when the review questions were actually answered, and only reaches
 * IN_PROGRESS while a position is still open.
 */
export function planSessionStatus(input: { plan: Record<string, unknown> | null; trades: PlanTrade[]; day: string }): SessionStatus {
  const plan = input.plan;
  const trades = dayTrades(input.trades, input.day);
  if (!plan) {
    return trades.length
      ? { key: "NOT_STARTED", label: "NOT STARTED", tone: "watch", detail: `${trades.length} trade${trades.length === 1 ? "" : "s"} logged without a saved plan for this day.` }
      : { key: "NOT_STARTED", label: "NOT STARTED", tone: "neutral", detail: "No plan saved for this day yet." };
  }
  if (!trades.length) return { key: "PLANNED", label: "PLANNED", tone: "safe", detail: "Plan saved. Session review starts after the first trade." };
  if (trades.some(isOpenTrade)) return { key: "IN_PROGRESS", label: "IN PROGRESS", tone: "watch", detail: `${trades.length} trade${trades.length === 1 ? "" : "s"} logged and a position is still open.` };
  if (!hasSessionReview(plan as PsychologyPlan)) return { key: "REVIEW_REQUIRED", label: "REVIEW REQUIRED", tone: "watch", detail: `${trades.length} closed trade${trades.length === 1 ? "" : "s"} logged. Save the session review.` };
  return { key: "REVIEWED", label: "REVIEWED", tone: "safe", detail: "Plan and execution review are saved for this day." };
}

export type PlanVsExecution = {
  plan: PsychologyPlan | null;
  planned: { riskLimit: number | null; maxTrades: number | null; sessions: string[]; rules: number; rulesApplied: number };
  actual: { trades: number; open: number; riskUsed: number; unplanned: number; violations: number };
  classifications: Record<TradeClassification, number>;
  adherence: number | null;
  riskLimitRespected: boolean | null;
  maxTradesRespected: boolean | null;
  deviations: string[];
  potentialBehaviouralDeviation: string | null;
  reviewSaved: boolean;
};

/**
 * The compact plan-versus-execution read: what was planned, what happened, the
 * adherence percentage, and only the deviations that matter. Built from the
 * same behavioural engine the rest of the journal uses, so the numbers here and
 * on the Psychology page can never disagree.
 */
export function planVsExecution(input: {
  plan: Record<string, unknown> | null;
  trades: PlanTrade[];
  day: string;
  config?: Partial<BehaviorConfig>;
}): PlanVsExecution {
  const plan = (input.plan ?? null) as PsychologyPlan | null;
  const trades = dayTrades(input.trades, input.day);
  const [session] = trades.length || plan ? buildTraderSessions(trades as PsychologyTrade[], plan ? [plan] : [], input.config) : [];
  const adherence = session?.planAdherence ?? null;
  const emptyCounts: Record<TradeClassification, number> = { GOOD_WIN: 0, BAD_WIN: 0, GOOD_LOSS: 0, BAD_LOSS: 0, NOT_EVALUATED: 0 };
  const riskLimit = plan?.riskLimit == null ? null : numberOrNull(plan.riskLimit);
  const maxTrades = plan?.maxTrades ?? null;
  const closed = trades.filter(trade => !isOpenTrade(trade));
  const riskUsed = closed.reduce((sum, trade) => sum + Math.max(0, numberOrNull(trade.risk) ?? 0), 0);
  const rulesApplied = rules(plan?.rulesPlanned).filter(rule => rule.checked).length;
  const potentialBehaviouralDeviation = (() => {
    const focus = clean(plan?.behavioralFocus);
    const offPlan = (adherence?.unplannedTrades ?? 0) + (adherence?.violations ?? 0);
    if (!focus || !closed.length) return null;
    if (offPlan > 0) {
      return `Potential behavioural deviation: today's focus was "${focus}" and ${offPlan} trade ${offPlan === 1 ? "was" : "were"} logged outside the plan or against a planned rule.`;
    }
    return `No behavioural deviation detected against today's focus ("${focus}").`;
  })();
  return {
    plan,
    planned: {
      riskLimit: riskLimit != null && riskLimit > 0 ? riskLimit : null,
      maxTrades,
      sessions: Array.isArray(plan?.sessionFocus) ? (plan?.sessionFocus as unknown[]).map(value => clean(value)).filter(Boolean) : [],
      rules: rules(plan?.rulesPlanned).length,
      rulesApplied,
    },
    actual: {
      trades: trades.length,
      open: trades.filter(isOpenTrade).length,
      riskUsed: Math.round(riskUsed * 100) / 100,
      unplanned: adherence?.unplannedTrades ?? 0,
      violations: adherence?.violations ?? 0,
    },
    classifications: session?.classificationCounts ?? emptyCounts,
    adherence: adherence?.adherence ?? null,
    riskLimitRespected: riskLimit != null && riskLimit > 0 ? riskUsed <= riskLimit : null,
    maxTradesRespected: maxTrades != null ? closed.length <= maxTrades : null,
    deviations: (adherence?.notes ?? []).slice(0, 4),
    potentialBehaviouralDeviation,
    reviewSaved: hasSessionReview(plan),
  };
}

/**
 * The current draft expressed in the saved-plan shape, so a copy can be taken
 * from what is on screen even when today has not been saved yet.
 */
export function draftAsPlanSource(draft: PlanDraft, planDate: number | string, id: number | null): Record<string, unknown> {
  return {
    id,
    planDate,
    preBias: draft.preBias,
    marketContext: draft.marketContext,
    keyLevels: draft.keyLevels,
    sessionFocus: draft.sessionFocus,
    eventRisk: draft.eventRisk,
    longScenario: draft.longScenario,
    shortScenario: draft.shortScenario,
    noTradeCondition: draft.noTradeCondition,
    invalidationLevel: draft.invalidationLevel,
    riskLimit: draft.riskLimit,
    maxTrades: draft.maxTrades === "" ? null : Number(draft.maxTrades),
    sizingPlan: draft.sizingPlan,
    planNotes: draft.planNotes,
    rulesPlanned: draft.rulesPlanned,
    behavioralFocus: draft.behavioralFocus,
    psychologyRisk: draft.psychologyRisk,
    tomorrowFocus: draft.tomorrowFocus,
  };
}

/** Recomputed rule adherence count for the review checklist label. */
export function appliedRules(draft: PlanDraft) {
  return { applied: draft.rulesPlanned.filter(rule => rule.checked), followed: draft.rulesFollowed.filter(rule => rule.yes).length };
}
