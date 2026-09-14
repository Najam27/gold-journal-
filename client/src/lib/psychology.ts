/**
 * Client adapter for the behavioural psychology engine.
 *
 * The heavy lifting lives in `@shared/psychologyEngine` so the server, the
 * dashboard, and tests all read identical numbers. This module only:
 *   • normalises journal payloads into engine input,
 *   • reads the per-trader behavioural configuration, and
 *   • exposes small helpers for the Goals, Plan, Calendar, and Trade Log views.
 *
 * Everything here is pure. Callers memoise with `useMemo` so an expensive
 * development report is never recomputed on every React render.
 */

import {
  DEFAULT_BEHAVIOR_CONFIG,
  analyzeTraderDevelopment,
  buildTraderSessions,
  classifyTradeProcess,
  detectDuplicateTickets,
  evaluatePreTradeGate,
  type BehaviorConfig,
  type DisciplineComponent,
  type PsychologyCheckin,
  type PsychologyPlan,
  type PsychologyTrade,
  type TraderDevelopmentReport,
  type TraderSession,
} from "@shared/psychologyEngine";
import { getPktDateKey } from "@shared/pktDate";

export {
  DEFAULT_BEHAVIOR_CONFIG,
  DEFAULT_DISCIPLINE_WEIGHTS,
  DISCIPLINE_COMPONENT_LABELS,
  EMOTIONAL_STATES,
  MISTAKE_BY_TAG,
  MISTAKE_CATEGORY_LABELS,
  MISTAKE_TAXONOMY,
  PRE_TRADE_GATE_ITEMS,
  TRADE_CLASSIFICATION_LABELS,
  TRADE_CLASSIFICATION_SUMMARY,
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
} from "@shared/psychologyEngine";
export type {
  BehaviorConfig,
  BehavioralFocus,
  BehavioralInsight,
  BehavioralPnl,
  BehavioralTag,
  CooldownState,
  DisciplineComponent,
  DisciplineScore,
  DisciplineStreaks,
  MistakeCategory,
  MistakeDefinition,
  PlanAdherence,
  PsychologyCheckin,
  PsychologyPlan,
  PsychologyTrade,
  TradeClassification,
  TraderDevelopmentReport,
  TraderSession,
  TradingReadiness,
  WeeklyPsychology,
} from "@shared/psychologyEngine";

/** The one primary behavioural objective a trader can choose per session. */
export const BEHAVIORAL_OBJECTIVES = [
  "Patience",
  "FOMO control",
  "Revenge control",
  "Impulse control",
  "Overconfidence control",
  "Loss acceptance",
  "Rule adherence",
  "Emotional stability",
  "Overtrading control",
  "Risk discipline",
  "Waiting for confirmation",
] as const;

export type TraderProfile = {
  identityStatement?: string | null;
  disciplineWeights?: Record<string, number> | null;
  behaviorConfig?: Record<string, number | null> | null;
} | null | undefined;

const BEHAVIOR_CONFIG_KEYS: (keyof BehaviorConfig)[] = ["maxTradesPerDay", "maxRiskPerTrade", "maxDailyLoss", "cooldownAfterLosses", "planAdherenceTarget", "focusTarget", "focusWindow", "weeklyWindow"];
const DISCIPLINE_KEYS: DisciplineComponent[] = ["risk", "plan", "setup", "execution", "overtrading", "journal", "psychology"];

/** Merges the saved behavioural configuration over the documented defaults. */
export function behaviorConfigFromProfile(profile: TraderProfile): BehaviorConfig {
  const saved = profile?.behaviorConfig;
  if (!saved || typeof saved !== "object") return { ...DEFAULT_BEHAVIOR_CONFIG };
  const merged: BehaviorConfig = { ...DEFAULT_BEHAVIOR_CONFIG };
  for (const key of BEHAVIOR_CONFIG_KEYS) {
    const value = saved[key];
    if (value === undefined || value === null) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) merged[key] = parsed;
  }
  return merged;
}

/** Reads the saved discipline weights, ignoring anything outside 0–100. */
export function disciplineWeightsFromProfile(profile: TraderProfile): Partial<Record<DisciplineComponent, number>> | undefined {
  const saved = profile?.disciplineWeights;
  if (!saved || typeof saved !== "object") return undefined;
  const weights: Partial<Record<DisciplineComponent, number>> = {};
  for (const key of DISCIPLINE_KEYS) {
    const value = Number((saved as Record<string, unknown>)[key]);
    if (Number.isFinite(value) && value >= 0 && value <= 100) weights[key] = value;
  }
  return Object.keys(weights).length ? weights : undefined;
}

export type JournalBehaviorInput = {
  trades?: unknown[] | null;
  plans?: unknown[] | null;
  traderProfile?: TraderProfile;
  checkin?: PsychologyCheckin | null;
};

/** Today's journal day key in Pakistan time, used to pick the "today" session. */
export function todayKey(now: Date = new Date()) {
  return getPktDateKey(now);
}

/**
 * Builds the full trader development report for one account.
 * Memoise the result: it walks every loaded trade and plan once.
 */
export function buildTraderDevelopment(input: JournalBehaviorInput): TraderDevelopmentReport {
  const trades = (input.trades ?? []) as PsychologyTrade[];
  const plans = (input.plans ?? []) as PsychologyPlan[];
  const profile = input.traderProfile ?? null;
  const report = analyzeTraderDevelopment({
    trades,
    plans,
    identityStatement: profile?.identityStatement ?? "",
    weights: disciplineWeightsFromProfile(profile),
    config: behaviorConfigFromProfile(profile),
    checkin: input.checkin ?? null,
    today: todayKey(),
  });
  return report;
}

/** The saved plan for one Pakistan-time day, if any. */
export function planForDay(plans: unknown[] | null | undefined, day: string): PsychologyPlan | null {
  for (const plan of (plans ?? []) as PsychologyPlan[]) {
    if (getPktDateKey(plan.planDate) === day) return plan;
  }
  return null;
}

/**
 * Behavioural review of a single calendar day: the plan adherence, the trade
 * classifications, the dominant emotion, and the saved lesson. Read-only.
 */
export function buildDayBehaviorReview(day: string, trades: unknown[] | null | undefined, plans: unknown[] | null | undefined, config?: Partial<BehaviorConfig>) {
  const plan = planForDay(plans, day);
  const [session] = buildTraderSessions((trades ?? []) as PsychologyTrade[], plan ? [plan] : [], config);
  if (!session) return null;
  const gate = session.closed.map(trade => evaluatePreTradeGate(trade.planChecklist));
  const answeredGates = gate.filter(item => item.score != null);
  return {
    day,
    plan: session.plan,
    session: session as TraderSession,
    classifications: session.classificationCounts,
    dominantEmotion: session.dominantEmotion,
    emotionalState: session.emotionalState,
    behavioralFocus: session.behavioralFocus,
    unplannedTrades: session.unplannedTrades,
    violations: session.violations,
    tags: session.tags,
    lesson: session.lesson,
    reviewed: session.reviewed,
    gateAverage: answeredGates.length ? Math.round(answeredGates.reduce((sum, item) => sum + (item.score ?? 0), 0) / answeredGates.length) : null,
    duplicateWarnings: detectDuplicateTickets(session.closed),
  };
}

/** Context the trade dialog uses to preview today's process classification. */
export function tradeProcessContext(options: { day: string; trades: unknown[] | null | undefined; plans: unknown[] | null | undefined; config?: Partial<BehaviorConfig> }) {
  const merged: BehaviorConfig = { ...DEFAULT_BEHAVIOR_CONFIG, ...(options.config ?? {}) };
  const plan = planForDay(options.plans, options.day);
  const [session] = buildTraderSessions((options.trades ?? []) as PsychologyTrade[], plan ? [plan] : [], merged);
  const riskCeiling = plan && Number(plan.riskLimit) > 0
    ? (plan.maxTrades && plan.maxTrades > 0 ? Number(plan.riskLimit) / plan.maxTrades : null) ?? merged.maxRiskPerTrade
    : merged.maxRiskPerTrade;
  return {
    plan,
    riskCeiling,
    maxTrades: plan?.maxTrades ?? merged.maxTradesPerDay ?? null,
    plannedSessions: Array.isArray(plan?.sessionFocus) ? (plan?.sessionFocus as unknown[]).map(value => String(value)) : [],
    hasPlan: Boolean(plan),
    sessionTradeCount: session?.closed.length ?? 0,
  };
}

/** Live classification preview for the trade form, before the trade is saved. */
export function previewTradeProcess(trade: PsychologyTrade, context: ReturnType<typeof tradeProcessContext>) {
  return classifyTradeProcess(trade, {
    riskCeiling: context.riskCeiling,
    hasPlan: context.hasPlan,
    plannedSessions: context.plannedSessions,
    maxTrades: context.maxTrades,
    tradeOrdinal: context.sessionTradeCount + 1,
  });
}
