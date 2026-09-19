/**
 * Behavioral psychology engine for Gold Journal.
 *
 * Every value produced here is derived from saved journal data: trade rows,
 * daily plans, and the optional pre-session check-in. The functions are pure,
 * deterministic, UI-free, and timezone-explicit (Pakistan Standard Time day
 * keys), so the dashboard, Goals page, calendar drill-down, and trade log can
 * all read the same numbers and tests can assert them directly.
 *
 * Two rules are enforced by design:
 *  1. P&L is never re-written. Behavioral P&L is an analytical split of the
 *     saved P&L, clearly labelled as process analysis.
 *  2. Observed facts are kept separate from interpretation. Insights carry a
 *     `kind` of "OBSERVED" or "INTERPRETATION" so the UI can never present a
 *     guess as a finding.
 */

import { getPktDateKey } from "./pktDate";


/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

export type MistakeCategory = "EMOTIONAL" | "EXECUTION" | "ANALYTICAL" | "ENVIRONMENTAL";

export type BehavioralTag =
  | "FOMO"
  | "REVENGE"
  | "FEAR"
  | "GREED"
  | "IMPATIENCE"
  | "OVERCONFIDENCE"
  | "HESITATION"
  | "BOREDOM"
  | "EARLY_ENTRY"
  | "LATE_ENTRY"
  | "MOVED_SL"
  | "REMOVED_SL"
  | "EARLY_EXIT"
  | "OVERSIZED"
  | "ADDED_TO_LOSER"
  | "OVERTRADING"
  | "WRONG_BIAS"
  | "IGNORED_HTF"
  | "IGNORED_LIQUIDITY"
  | "POOR_SETUP"
  | "NO_CONFIRMATION"
  | "IGNORED_INVALIDATION"
  | "TRADED_TIRED"
  | "TRADED_DISTRACTED"
  | "OUTSIDE_SESSION"
  | "UNSUITABLE_CONDITIONS"
  | "AFTER_EMOTIONAL_EVENT";

export type MistakeDefinition = {
  tag: BehavioralTag;
  /** Canonical label written back into the existing `mistake` tag string. */
  label: string;
  category: MistakeCategory;
  /** A rule break by itself. Emotional states such as fear or hesitation are not. */
  violation: boolean;
  /** Historic tag spellings that already exist in user data. */
  aliases: string[];
};

export const MISTAKE_TAXONOMY: MistakeDefinition[] = [
  { tag: "FOMO", label: "FOMO", category: "EMOTIONAL", violation: true, aliases: ["fomo", "chase", "chased", "fear of missing out"] },
  { tag: "REVENGE", label: "Revenge", category: "EMOTIONAL", violation: true, aliases: ["revenge", "revenge trade", "recover loss", "breakeven chase", "get it back"] },
  { tag: "FEAR", label: "Fear", category: "EMOTIONAL", violation: false, aliases: ["fear", "scared", "afraid"] },
  { tag: "GREED", label: "Greed", category: "EMOTIONAL", violation: false, aliases: ["greed", "greedy", "wanting more"] },
  { tag: "IMPATIENCE", label: "Impatience", category: "EMOTIONAL", violation: true, aliases: ["impatience", "impatient", "rushed"] },
  { tag: "OVERCONFIDENCE", label: "Overconfidence", category: "EMOTIONAL", violation: true, aliases: ["overconfidence", "over confident", "overconfident"] },
  { tag: "HESITATION", label: "Hesitation", category: "EMOTIONAL", violation: false, aliases: ["hesitation", "hesitant", "second guessed"] },
  { tag: "BOREDOM", label: "Boredom", category: "EMOTIONAL", violation: true, aliases: ["boredom", "bored"] },
  { tag: "EARLY_ENTRY", label: "Early entry", category: "EXECUTION", violation: true, aliases: ["early entry", "entered early", "front ran"] },
  { tag: "LATE_ENTRY", label: "Late entry", category: "EXECUTION", violation: true, aliases: ["late entry", "entered late", "chased entry"] },
  { tag: "MOVED_SL", label: "Moved SL", category: "EXECUTION", violation: true, aliases: ["moved sl", "moved stop", "widened stop", "moved stop loss"] },
  { tag: "REMOVED_SL", label: "Removed SL", category: "EXECUTION", violation: true, aliases: ["removed sl", "no stop", "no sl", "stop removed", "stop loss removed"] },
  { tag: "EARLY_EXIT", label: "Closed early", category: "EXECUTION", violation: true, aliases: ["closed early", "early exit", "cut winner", "exited early"] },
  { tag: "OVERSIZED", label: "Oversize", category: "EXECUTION", violation: true, aliases: ["oversize", "oversized", "over sized", "over-risked", "over risk", "over risked"] },
  { tag: "ADDED_TO_LOSER", label: "Added to loser", category: "EXECUTION", violation: true, aliases: ["added to loser", "averaged down", "added to loss"] },
  { tag: "OVERTRADING", label: "Overtrading", category: "EXECUTION", violation: true, aliases: ["overtrading", "overtrade", "over-trading", "too many trades"] },
  { tag: "WRONG_BIAS", label: "Wrong bias", category: "ANALYTICAL", violation: true, aliases: ["wrong bias", "bad bias", "bias error"] },
  { tag: "IGNORED_HTF", label: "Ignored higher timeframe", category: "ANALYTICAL", violation: true, aliases: ["ignored higher timeframe", "ignored htf", "no htf check"] },
  { tag: "IGNORED_LIQUIDITY", label: "Ignored liquidity", category: "ANALYTICAL", violation: true, aliases: ["ignored liquidity", "no liquidity check"] },
  { tag: "POOR_SETUP", label: "Poor setup", category: "ANALYTICAL", violation: true, aliases: ["poor setup", "bad setup", "b setup"] },
  { tag: "NO_CONFIRMATION", label: "Entered without confirmation", category: "ANALYTICAL", violation: true, aliases: ["entered without confirmation", "no confirmation", "no confirmation signal"] },
  { tag: "IGNORED_INVALIDATION", label: "Ignored invalidation", category: "ANALYTICAL", violation: true, aliases: ["ignored invalidation", "ignored invalidation level", "no invalidation"] },
  { tag: "TRADED_TIRED", label: "Trading tired", category: "ENVIRONMENTAL", violation: true, aliases: ["trading tired", "traded tired", "sleep deprived"] },
  { tag: "TRADED_DISTRACTED", label: "Trading distracted", category: "ENVIRONMENTAL", violation: true, aliases: ["trading distracted", "traded distracted", "distracted"] },
  { tag: "OUTSIDE_SESSION", label: "Trading outside session", category: "ENVIRONMENTAL", violation: true, aliases: ["trading outside session", "outside session", "wrong session", "out of session"] },
  { tag: "UNSUITABLE_CONDITIONS", label: "Trading during unsuitable conditions", category: "ENVIRONMENTAL", violation: true, aliases: ["trading during unsuitable conditions", "unsuitable conditions", "bad conditions", "traded the chop"] },
  { tag: "AFTER_EMOTIONAL_EVENT", label: "Trading after emotional event", category: "ENVIRONMENTAL", violation: true, aliases: ["trading after emotional event", "after emotional event", "emotional event"] },
];

export const MISTAKE_BY_TAG: Record<BehavioralTag, MistakeDefinition> = Object.fromEntries(MISTAKE_TAXONOMY.map(item => [item.tag, item])) as Record<BehavioralTag, MistakeDefinition>;

export const MISTAKE_CATEGORY_LABELS: Record<MistakeCategory, string> = {
  EMOTIONAL: "Emotional",
  EXECUTION: "Execution",
  ANALYTICAL: "Analytical",
  ENVIRONMENTAL: "Environmental",
};

export type TradeClassification = "GOOD_WIN" | "BAD_WIN" | "GOOD_LOSS" | "BAD_LOSS" | "NOT_EVALUATED";

export const TRADE_CLASSIFICATION_LABELS: Record<TradeClassification, string> = {
  GOOD_WIN: "Good win",
  BAD_WIN: "Bad win",
  GOOD_LOSS: "Good loss",
  BAD_LOSS: "Bad loss",
  NOT_EVALUATED: "Not evaluated",
};

export const TRADE_CLASSIFICATION_SUMMARY: Record<TradeClassification, string> = {
  GOOD_WIN: "Valid process, profitable outcome.",
  BAD_WIN: "Profitable result, poor process.",
  GOOD_LOSS: "Valid process, unfavorable outcome.",
  BAD_LOSS: "Poor process, losing outcome.",
  NOT_EVALUATED: "No behavioural data saved for this trade.",
};

/* ------------------------------------------------------------------ *
 * Input models
 * ------------------------------------------------------------------ */

export type PlanStatus = "PLANNED" | "UNPLANNED" | "NOT_EVALUATED";

export type PsychologyTrade = {
  id?: number | string | null;
  tradeDate: number | string | Date;
  result?: string | null;
  pnl?: number | string | null;
  risk?: number | string | null;
  reward?: number | string | null;
  session?: string | null;
  setupQuality?: string | null;
  mistake?: string | null;
  patienceScore?: number | string | null;
  holdQuality?: string | null;
  slPlacement?: string | null;
  emotionBefore?: string | null;
  emotionDuring?: string | null;
  emotionAfter?: string | null;
  planStatus?: string | null;
  planChecklist?: unknown;
  mt5Ticket?: unknown;
};

export type ChecklistItem = { id: string; label?: string; text?: string; checked?: boolean; yes?: boolean };

/**
 * The one behaviour a trader chooses to control for a session.
 *
 * The first block is the action language the plan workflow asks for; the second
 * block is every value the journal has already stored, kept selectable so an
 * older plan still renders its own objective instead of silently losing it.
 */
export const BEHAVIORAL_OBJECTIVES = [
  "Wait for confirmation",
  "Respect stop loss",
  "Avoid revenge trading",
  "Avoid overtrading",
  "Follow session limits",
  "Do not chase entries",
  "Accept missed trades",
  "Respect planned exit",
  "Trade only A setups",
  "Reduce impulsive entries",
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

/**
 * What triggered an emotional reaction during the session.
 *
 * `tag` links a trigger to the behavioural taxonomy where one exists, which is
 * how a trigger can be related to a saved rule violation without claiming that
 * the trigger caused it.
 */
export const PSYCHOLOGY_TRIGGERS: { key: string; label: string; tag: BehavioralTag | null }[] = [
  { key: "FOMO", label: "Fear of missing out", tag: "FOMO" },
  { key: "FEAR_AFTER_LOSS", label: "Fear after loss", tag: null },
  { key: "REVENGE", label: "Revenge impulse", tag: "REVENGE" },
  { key: "GREED", label: "Greed", tag: null },
  { key: "IMPATIENCE", label: "Impatience", tag: "IMPATIENCE" },
  { key: "OVERCONFIDENCE", label: "Overconfidence", tag: null },
  { key: "HESITATION", label: "Hesitation", tag: null },
  { key: "GIVING_BACK_PROFIT", label: "Fear of giving back profit", tag: "EARLY_EXIT" },
  { key: "BOREDOM", label: "Boredom", tag: "OVERTRADING" },
  { key: "RECOVER_LOSSES", label: "Need to recover losses", tag: "REVENGE" },
  { key: "EXTERNAL_DISTRACTION", label: "External distraction", tag: null },
  { key: "FATIGUE", label: "Fatigue", tag: null },
  { key: "STRESS", label: "Stress", tag: null },
  { key: "NONE", label: "No significant trigger", tag: null },
];

export const BEHAVIORAL_OBJECTIVE_STATUSES = ["YES", "PARTIALLY", "NO"] as const;
export type BehavioralObjectiveStatus = (typeof BEHAVIORAL_OBJECTIVE_STATUSES)[number];

export const BEHAVIORAL_OBJECTIVE_STATUS_LABELS: Record<BehavioralObjectiveStatus, string> = {
  YES: "Yes — the objective held",
  PARTIALLY: "Partially — it held some of the time",
  NO: "No — it did not hold",
};

/** Splits any historic serialisation of the trigger list into stable keys. */
export function parsePsychologyTriggers(value: unknown): string[] {
  let raw: unknown[] = [];
  if (Array.isArray(value)) raw = value;
  else {
    const text = clean(value);
    if (!text) return [];
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) raw = parsed;
      } catch {
        return [];
      }
    } else raw = text.split("|");
  }
  return Array.from(new Set(raw.map(item => clean(item)).filter(Boolean)));
}

/** The human label for a trigger key; an unknown key is shown as saved. */
export function psychologyTriggerLabel(key: string) {
  return PSYCHOLOGY_TRIGGERS.find(trigger => trigger.key === key)?.label ?? clean(key);
}

export function parseBehavioralObjectiveStatus(value: unknown): BehavioralObjectiveStatus | null {
  const text = clean(value).toUpperCase();
  return (BEHAVIORAL_OBJECTIVE_STATUSES as readonly string[]).includes(text) ? (text as BehavioralObjectiveStatus) : null;
}

export type PostSessionBehavioralReview = {
  followPlan: BehavioralObjectiveStatus | null;
  nextSessionChange: string;
  triggerAction: string;
};

export function parsePostSessionBehavioralReview(value: unknown): PostSessionBehavioralReview | null {
  if (!value) return null;
  let source: unknown = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof source !== "object" || Array.isArray(source)) return null;
  const record = source as Record<string, unknown>;
  const review: PostSessionBehavioralReview = {
    followPlan: parseBehavioralObjectiveStatus(record.followPlan),
    nextSessionChange: clean(record.nextSessionChange),
    triggerAction: clean(record.triggerAction),
  };
  return review.followPlan || review.nextSessionChange || review.triggerAction ? review : null;
}

/**
 * "Reviewed" means the after-session questions were actually answered.
 * The optional execution score and session rating are no longer required for a
 * review to count, because the compact review asks one behaviour question, one
 * deviation, one lesson, and one next-session change instead.
 */
export function hasSessionReview(plan: PsychologyPlan | null | undefined) {
  if (!plan) return false;
  return Boolean(
    plan.executionScore != null
    || plan.overallRating != null
    || parseBehavioralObjectiveStatus(plan.behavioralObjectiveStatus)
    || parsePostSessionBehavioralReview(plan.postSessionBehavioralReview)
    || clean(plan.planDeviation)
    || clean(plan.whatWentWell)
    || clean(plan.whatWentWrong)
    || clean(plan.lessons)
    || clean(plan.tomorrowFocus),
  );
}

/**
 * Decision-oriented behavioural summary: what is improving, what repeats, which
 * triggers sit next to rule breaks, and what to focus on next. Every value is
 * derived from saved plans and trades — nothing is inferred from a missing
 * answer, and an empty journal reports "no data" rather than a score.
 */
export type BehavioralFeedback = {
  window: number;
  sessions: number;
  focusLabel: string | null;
  focusStatus: BehavioralObjectiveStatus | null;
  reviewStreak: number;
  taggedSessions: number;
  reviewedSessions: number;
  repeatedTrigger: { key: string; label: string; sessions: number; violations: number } | null;
  violationLinkedTriggers: { key: string; label: string; sessions: number; violations: number }[];
  triggerCounts: { key: string; label: string; sessions: number; violations: number }[];
  objectiveHoldRate: number | null;
  nextAction: string | null;
  note: string;
};

export function calculateBehavioralFeedback(sessions: TraderSession[], configInput: Partial<BehaviorConfig> = {}): BehavioralFeedback {
  const config: BehaviorConfig = { ...DEFAULT_BEHAVIOR_CONFIG, ...configInput };
  const window = Math.max(config.focusWindow, 10);
  const ordered = [...sessions]
    .sort((a, b) => a.day.localeCompare(b.day))
    .filter(session => session.plan || session.closed.length > 0)
    .slice(-window);
  const latestPlanSession = [...ordered].reverse().find(session => session.plan) ?? null;
  const counts = new Map<string, { sessions: number; violations: number }>();
  const statuses: BehavioralObjectiveStatus[] = [];
  for (const session of ordered) {
    const status = parseBehavioralObjectiveStatus(session.plan?.behavioralObjectiveStatus);
    if (status) statuses.push(status);
    for (const key of parsePsychologyTriggers(session.plan?.psychologyTriggers)) {
      if (key === "NONE") continue;
      const entry = counts.get(key) ?? { sessions: 0, violations: 0 };
      entry.sessions += 1;
      // A trigger is only counted alongside a rule break when the behaviour it
      // names was itself flagged in that session. Recording a trigger next to a
      // violation is a correlation the trader can see — it is never reported as
      // the cause of one.
      const tag = PSYCHOLOGY_TRIGGERS.find(trigger => trigger.key === key)?.tag ?? null;
      if (tag && session.violations.includes(tag)) entry.violations += 1;
      counts.set(key, entry);
    }
  }
  const triggerCounts = Array.from(counts.entries())
    .map(([key, entry]) => ({ key, label: psychologyTriggerLabel(key), sessions: entry.sessions, violations: entry.violations }))
    .sort((a, b) => b.sessions - a.sessions || b.violations - a.violations || a.key.localeCompare(b.key));
  const repeated = triggerCounts.find(entry => entry.sessions >= 2) ?? null;
  const objectiveHoldRate = statuses.length
    ? round(statuses.reduce((sum, status) => sum + (status === "YES" ? 1 : status === "PARTIALLY" ? 0.5 : 0), 0) / statuses.length * 100)
    : null;
  const focus = calculateBehavioralFocus(ordered, config);
  const focusLabel = clean(latestPlanSession?.plan?.behavioralFocus) || focus?.label || null;
  const focusStatus = parseBehavioralObjectiveStatus(latestPlanSession?.plan?.behavioralObjectiveStatus);
  const nextAction = repeated
    ? `${repeated.label} appeared in ${repeated.sessions} of the last ${ordered.length} sessions. Set it as today's single objective.`
    : focus?.recommendation ?? (statuses.length ? "Keep one objective per session so trigger history stays measurable." : null);
  return {
    window,
    sessions: ordered.length,
    focusLabel,
    focusStatus,
    reviewStreak: calculateStreaks(ordered, config).journal,
    taggedSessions: ordered.filter(session => parsePsychologyTriggers(session.plan?.psychologyTriggers).some(key => key !== "NONE")).length,
    reviewedSessions: statuses.length,
    repeatedTrigger: repeated,
    violationLinkedTriggers: triggerCounts.filter(entry => entry.violations > 0).sort((a, b) => b.violations - a.violations || b.sessions - a.sessions),
    triggerCounts,
    objectiveHoldRate,
    nextAction,
    note: triggerCounts.length || statuses.length
      ? "Triggers and objective verdicts come from saved session reviews. They describe what was recorded, not what caused an outcome."
      : "No triggers or objective verdicts are saved yet. The post-session review records them in a few seconds per session.",
  };
}

export type PsychologyPlan = {
  id?: number | null;
  planDate: number | string | Date;
  riskLimit?: string | number | null;
  maxTrades?: number | null;
  sessionFocus?: unknown;
  noTradeCondition?: string | null;
  rulesPlanned?: unknown;
  rulesFollowed?: unknown;
  executionScore?: number | null;
  overallRating?: number | null;
  emotionStart?: unknown;
  emotionEnd?: unknown;
  emotionalState?: string | null;
  energyLevel?: number | null;
  focusLevel?: number | null;
  confidenceLevel?: number | null;
  stressLevel?: number | null;
  behavioralFocus?: string | null;
  psychologyRisk?: string | null;
  planDeviation?: string | null;
  lessons?: string | null;
  tomorrowFocus?: string | null;
  whatWentWell?: string | null;
  whatWentWrong?: string | null;
  /** Which saved plan this one was copied from. Provenance only, never a live template. */
  copiedFromPlanId?: number | null;
  copiedFromPlanDate?: number | string | Date | null;
  psychologyTriggers?: unknown;
  primaryPsychologyTrigger?: string | null;
  behavioralObjectiveStatus?: string | null;
  postSessionBehavioralReview?: unknown;
};

export type BehaviorConfig = {
  /** Fallback daily trade ceiling when the plan does not define one. */
  maxTradesPerDay: number | null;
  /** Fallback per-trade risk ceiling in account currency when no plan limit exists. */
  maxRiskPerTrade: number | null;
  /** Positive daily loss magnitude that ends the session. */
  maxDailyLoss: number | null;
  /** Consecutive losses that trigger the cooldown prompt. */
  cooldownAfterLosses: number;
  /** Plan-adherence percentage used by the discipline streak model. */
  planAdherenceTarget: number;
  /** Control percentage a behavioural focus aims to reach. */
  focusTarget: number;
  /** Sessions included in the behavioural focus window. */
  focusWindow: number;
  /** Sessions included in the weekly psychology report. */
  weeklyWindow: number;
};

export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = {
  maxTradesPerDay: null,
  maxRiskPerTrade: null,
  maxDailyLoss: null,
  cooldownAfterLosses: 2,
  planAdherenceTarget: 80,
  focusTarget: 85,
  focusWindow: 7,
  weeklyWindow: 5,
};

export type DisciplineComponent = "risk" | "plan" | "setup" | "execution" | "overtrading" | "journal" | "psychology";

export const DEFAULT_DISCIPLINE_WEIGHTS: Record<DisciplineComponent, number> = {
  risk: 25,
  plan: 20,
  setup: 20,
  execution: 15,
  overtrading: 10,
  journal: 5,
  psychology: 5,
};

export const DISCIPLINE_COMPONENT_LABELS: Record<DisciplineComponent, string> = {
  risk: "Risk adherence",
  plan: "Plan adherence",
  setup: "Setup adherence",
  execution: "Execution discipline",
  overtrading: "Overtrading control",
  journal: "Journal / review",
  psychology: "Psychological control",
};

/* ------------------------------------------------------------------ *
 * Small deterministic helpers
 * ------------------------------------------------------------------ */

export const BEHAVIOR_TAG_FOCUS: { key: BehavioralTag; label: string; recommendation: string }[] = [
  { key: "FOMO", label: "FOMO", recommendation: "For the next 5 sessions, take only entries that satisfy your written confirmation trigger." },
  { key: "REVENGE", label: "Revenge", recommendation: "After any loss, complete the cooldown before considering one planned setup." },
  { key: "OVERTRADING", label: "Overtrading", recommendation: "Close the platform once the planned number of attempts is used." },
  { key: "OVERSIZED", label: "Risk discipline", recommendation: "Return to the planned risk per trade and confirm size before every entry." },
  { key: "IMPATIENCE", label: "Patience", recommendation: "Wait for the planned level to be reached instead of entering on the move." },
  { key: "POOR_SETUP", label: "Setup quality", recommendation: "Only execute trades that match your A / A+ setup standard." },
  { key: "MOVED_SL", label: "Stop discipline", recommendation: "Set the stop before entry and never widen it afterwards." },
  { key: "LATE_ENTRY", label: "Entry timing", recommendation: "Enter at the planned level or skip the trade entirely." },
  { key: "EARLY_ENTRY", label: "Entry timing", recommendation: "Wait for the confirmation close before executing." },
];

function finite(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clean(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function pct(part: number, whole: number) {
  return whole > 0 ? clamp(part / whole * 100) : null;
}

/** Splits any historic serialisation of the `mistake` column into tags. */
export function normalizeMistakeTags(value: unknown): string[] {
  const raw = clean(value);
  if (!raw) return [];
  let values: string[] = [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) values = parsed.map(entry => clean(entry));
      else values = raw.split(/[;,|/]+/);
    } catch {
      values = raw.split(/[;,|/]+/);
    }
  } else {
    values = raw.split(/[;,|/]+/);
  }
  return Array.from(new Set(values.map(entry => entry.trim()).filter(entry => entry && entry.toLowerCase() !== "none")));
}

/** Maps saved tag text onto the behavioural taxonomy. Unrecognised tags are returned as `unknown`. */
export function detectBehavioralTags(value: unknown): { tags: BehavioralTag[]; unknown: string[] } {
  const tags = new Set<BehavioralTag>();
  const unknown: string[] = [];
  for (const token of normalizeMistakeTags(value)) {
    const needle = token.toLowerCase();
    const match = MISTAKE_TAXONOMY.find(definition =>
      definition.aliases.some(alias => needle === alias || needle.includes(alias)) || needle === definition.label.toLowerCase()
    );
    if (match) tags.add(match.tag);
    else unknown.push(token);
  }
  return { tags: Array.from(tags), unknown };
}

export function tagsForCategory(tags: BehavioralTag[], category: MistakeCategory) {
  return tags.filter(tag => MISTAKE_BY_TAG[tag].category === category);
}

export function violationTags(tags: BehavioralTag[]) {
  return tags.filter(tag => MISTAKE_BY_TAG[tag].violation);
}

export function parseChecklist(value: unknown): ChecklistItem[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry, index) => ({
        id: clean(entry.id) || String(index),
        label: clean(entry.label ?? entry.text) || undefined,
        text: clean(entry.text ?? entry.label) || undefined,
        checked: Boolean(entry.checked ?? entry.yes),
        yes: Boolean(entry.yes ?? entry.checked),
      }));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(([id, checked]) => ({ id, checked: Boolean(checked) }));
  }
  return [];
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(entry => clean(entry)).filter(Boolean);
  return String(value ?? "").split("|").map(entry => entry.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Pre-trade gate
 * ------------------------------------------------------------------ */

export const PRE_TRADE_GATE_ITEMS: { id: string; label: string }[] = [
  { id: "setup-exists", label: "Setup exists" },
  { id: "matches-plan", label: "Setup matches today's plan" },
  { id: "entry-confirmed", label: "Entry condition confirmed" },
  { id: "stop-defined", label: "Stop-loss defined" },
  { id: "risk-in-limit", label: "Risk is within limit" },
  { id: "size-valid", label: "Position size is valid" },
  { id: "rr-acceptable", label: "Reward / risk acceptable" },
  { id: "session-valid", label: "Session is valid" },
  { id: "no-emotional-trigger", label: "No emotional trigger detected" },
  { id: "not-revenge", label: "Not revenge / FOMO driven" },
];

export function evaluatePreTradeGate(value: unknown) {
  const items = parseChecklist(value);
  const answered = items.filter(item => item.label || item.text || item.id);
  if (!answered.length) return { answered: 0, passed: 0, score: null as number | null, failed: [] as string[] };
  const failed = answered.filter(item => !item.checked).map(item => item.label ?? item.text ?? item.id);
  const passed = answered.length - failed.length;
  return { answered: answered.length, passed, score: round(passed / answered.length * 100), failed };
}

/* ------------------------------------------------------------------ *
 * Per-trade process assessment
 * ------------------------------------------------------------------ */

export type TradeProcessContext = {
  /** Per-trade risk ceiling resolved from the session plan or config. */
  riskCeiling?: number | null;
  /** Session declared by the plan, if any. */
  plannedSessions?: string[];
  /** Whether the day has a saved plan at all. */
  hasPlan?: boolean;
  /** Number of trades already taken that day, including this one. */
  tradeOrdinal?: number;
  /** Max trades the plan allows. */
  maxTrades?: number | null;
  /** Whether the immediately preceding closed trade that day was a loss. */
  previousWasLoss?: boolean;
};

export type TradeProcessAssessment = {
  classification: TradeClassification;
  /** Whether the trade met every evaluable process standard. */
  processCompliant: boolean | null;
  ruleAdherence: number | null;
  riskAdherence: number | null;
  setupAdherence: number | null;
  executionAdherence: number | null;
  tags: BehavioralTag[];
  violations: BehavioralTag[];
  reasons: string[];
  observed: string[];
  planStatus: PlanStatus;
  /** True when no behavioural field exists, e.g. an untouched MT5 import. */
  notEvaluated: boolean;
};

export function classifyPlanStatus(trade: PsychologyTrade): PlanStatus {
  const raw = clean(trade.planStatus).toUpperCase();
  if (raw === "PLANNED" || raw === "UNPLANNED") return raw;
  return "NOT_EVALUATED";
}

/**
 * Classifies a single trade as good win / bad win / good loss / bad loss.
 * "Not evaluated" is returned when the saved record carries no behavioural
 * evidence (typical for a raw MT5 import), instead of inventing values.
 */
export function classifyTradeProcess(trade: PsychologyTrade, context: TradeProcessContext = {}): TradeProcessAssessment {
  const { tags, unknown } = detectBehavioralTags(trade.mistake);
  const violations = violationTags(tags);
  const planStatus = classifyPlanStatus(trade);
  const gate = evaluatePreTradeGate(trade.planChecklist);
  const setupQuality = clean(trade.setupQuality).toUpperCase();
  const risk = finite(trade.risk);
  const pnl = finite(trade.pnl);
  const patience = trade.patienceScore == null || clean(trade.patienceScore) === "" ? null : finite(trade.patienceScore);
  const holdQuality = clean(trade.holdQuality).toLowerCase();
  const riskCeiling = context.riskCeiling == null || !Number.isFinite(context.riskCeiling) ? null : context.riskCeiling;
  const reasons: string[] = [];
  const observed: string[] = [];

  const setupEvaluable = Boolean(setupQuality);
  const setupValid = setupQuality ? setupQuality === "A" || setupQuality === "A+" : null;
  if (setupEvaluable && setupValid === false) reasons.push(`Setup quality saved as ${setupQuality}.`);
  if (tagsForCategory(tags, "ANALYTICAL").length) reasons.push(`Analytical mistake tagged: ${tagsForCategory(tags, "ANALYTICAL").map(tag => MISTAKE_BY_TAG[tag].label).join(", ")}.`);

  const oversizedByTag = tags.includes("OVERSIZED");
  const riskEvaluable = risk > 0 && riskCeiling != null ? true : oversizedByTag;
  let riskAdherence: number | null = null;
  if (oversizedByTag) {
    riskAdherence = 0;
    reasons.push("Saved position was tagged as oversized.");
  } else if (risk > 0 && riskCeiling != null) {
    riskAdherence = risk <= riskCeiling ? 100 : clamp(100 - (risk - riskCeiling) / riskCeiling * 100);
    if (risk > riskCeiling) reasons.push(`Risk ${round(risk, 2)} exceeded the ${round(riskCeiling, 2)} per-trade ceiling.`);
  } else if (risk > 0) {
    riskAdherence = 100;
  }
  if (context.maxTrades != null && (context.tradeOrdinal ?? 0) > context.maxTrades) {
    reasons.push(`Trade ${context.tradeOrdinal} exceeded the ${context.maxTrades}-trade daily cap.`);
    observed.push(`Trade ${context.tradeOrdinal} of the day, above the planned cap of ${context.maxTrades}.`);
  }
  if (planStatus === "UNPLANNED") reasons.push("Trade was marked as not part of the plan.");
  const plannedSessions = (context.plannedSessions ?? []).filter(Boolean);
  if (context.hasPlan && plannedSessions.length && clean(trade.session) && !plannedSessions.includes(clean(trade.session))) {
    reasons.push(`Session ${clean(trade.session)} was outside the planned session focus.`);
  }
  if (tags.includes("OVERTRADING")) reasons.push("Tagged as overtrading.");
  if (tags.includes("REVENGE")) observed.push("Tagged as revenge.");
  if (context.previousWasLoss && planStatus === "UNPLANNED") observed.push("Entered directly after a losing trade.");

  const executionTags = tagsForCategory(tags, "EXECUTION");
  let executionAdherence: number | null = null;
  if (executionTags.length) {
    executionAdherence = clamp(100 - executionTags.length * 34);
    reasons.push(`Execution mistake tagged: ${executionTags.map(tag => MISTAKE_BY_TAG[tag].label).join(", ")}.`);
  } else if (patience != null || holdQuality || setupEvaluable) {
    executionAdherence = 100;
    if (patience != null && patience <= 2) { executionAdherence = 60; reasons.push(`Patience score saved as ${patience}/5.`); }
    if (holdQuality === "poor") { executionAdherence = Math.min(executionAdherence ?? 100, 60); reasons.push("Hold quality saved as poor."); }
  }

  const emotionalTags = tagsForCategory(tags, "EMOTIONAL");
  const environmentalTags = tagsForCategory(tags, "ENVIRONMENTAL");
  const setupAdherence = setupEvaluable ? (setupValid ? 100 - tagsForCategory(tags, "ANALYTICAL").length * 25 : 0) : null;

  const checklistAdherence = gate.score;
  const evaluableSignals = [
    setupEvaluable,
    riskEvaluable,
    Boolean(executionTags.length),
    planStatus !== "NOT_EVALUATED",
    checklistAdherence != null,
    patience != null,
    Boolean(holdQuality),
    tags.length > 0,
    Boolean(unknown.length),
  ].filter(Boolean).length;
  const notEvaluated = evaluableSignals === 0;

  if (unknown.length) reasons.push(`Unrecognised mistake tag saved: ${unknown.join(", ")}.`);

  // A tag the user wrote themselves — even one outside the taxonomy — counts as a
  // rule break, so process compliance never looks better than the saved record.
  const hardViolations = violations.length > 0 || unknown.length > 0 || planStatus === "UNPLANNED";
  const components = [checklistAdherence, riskAdherence, setupAdherence, executionAdherence].filter((value): value is number => value != null);
  const ruleAdherence = notEvaluated ? null : components.length ? round(components.reduce((sum, value) => sum + value, 0) / components.length) : hardViolations ? 25 : 100;

  const processCompliant = notEvaluated ? null : !hardViolations && (setupValid !== false) && (executionAdherence == null || executionAdherence >= 80) && (checklistAdherence == null || checklistAdherence >= 80) && (riskAdherence == null || riskAdherence >= 80);

  let classification: TradeClassification = "NOT_EVALUATED";
  if (!notEvaluated) {
    const profitable = pnl > 0;
    const good = Boolean(processCompliant);
    classification = profitable ? (good ? "GOOD_WIN" : "BAD_WIN") : good ? "GOOD_LOSS" : "BAD_LOSS";
  }

  if (environmentalTags.length) reasons.push(`Environment flagged: ${environmentalTags.map(tag => MISTAKE_BY_TAG[tag].label).join(", ")}.`);
  if (emotionalTags.length) observed.push(`Emotional trigger tagged: ${emotionalTags.map(tag => MISTAKE_BY_TAG[tag].label).join(", ")}.`);

  return {
    classification,
    processCompliant,
    ruleAdherence,
    riskAdherence,
    setupAdherence,
    executionAdherence,
    tags,
    violations,
    reasons,
    observed,
    planStatus,
    notEvaluated,
  };
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

export type ComponentScore = { score: number | null; sample: number; violations: number };

export type PlanAdherence = {
  plannedTrades: number | null;
  actualTrades: number;
  plannedRisk: number | null;
  actualRisk: number;
  plannedSessions: string[];
  actualSessions: string[];
  plannedFocus: string | null;
  unplannedTrades: number;
  violations: number;
  adherence: number | null;
  components: { label: string; value: number | null }[];
  notes: string[];
};

export type TraderSession = {
  day: string;
  plan: PsychologyPlan | null;
  trades: PsychologyTrade[];
  closed: PsychologyTrade[];
  openCount: number;
  pnl: number;
  wins: number;
  losses: number;
  breakEven: number;
  totalRisk: number;
  assessments: TradeProcessAssessment[];
  classificationCounts: Record<TradeClassification, number>;
  tags: BehavioralTag[];
  violations: BehavioralTag[];
  unplannedTrades: number;
  behavioralFocus: string | null;
  emotionalState: string | null;
  dominantEmotion: string | null;
  reviewed: boolean;
  /** The compact after-session behavioural review was answered for this day. */
  behavioralReviewed: boolean;
  behavioralTriggers: string[];
  objectiveStatus: BehavioralObjectiveStatus | null;
  lesson: string | null;
  planAdherence: PlanAdherence;
  components: Record<DisciplineComponent, ComponentScore>;
  discipline: number | null;
};

export function groupTradingSessions(trades: PsychologyTrade[], plans: PsychologyPlan[] = []): { day: string; trades: PsychologyTrade[]; plan: PsychologyPlan | null }[] {
  const byDay = new Map<string, PsychologyTrade[]>();
  for (const trade of trades) {
    const day = getPktDateKey(trade.tradeDate);
    if (!day) continue;
    const bucket = byDay.get(day);
    if (bucket) bucket.push(trade);
    else byDay.set(day, [trade]);
  }
  const planByDay = new Map<string, PsychologyPlan>();
  for (const plan of plans) {
    const day = getPktDateKey(plan.planDate);
    if (!day) continue;
    if (!planByDay.has(day)) planByDay.set(day, plan);
  }
  const days = Array.from(new Set(Array.from(byDay.keys()).concat(Array.from(planByDay.keys())))).sort();
  return days.map(day => ({
    day,
    plan: planByDay.get(day) ?? null,
    trades: [...(byDay.get(day) ?? [])].sort((a, b) => new Date(a.tradeDate).getTime() - new Date(b.tradeDate).getTime()),
  }));
}

function planRiskCeiling(plan: PsychologyPlan | null) {
  const limit = finite(plan?.riskLimit);
  const maxTrades = plan?.maxTrades ?? null;
  if (limit <= 0) return null;
  if (maxTrades && maxTrades > 0) return limit / maxTrades;
  return null;
}

export function resolveRiskCeiling(plan: PsychologyPlan | null, config: BehaviorConfig) {
  const fromPlan = planRiskCeiling(plan);
  if (fromPlan != null && fromPlan > 0) return fromPlan;
  return config.maxRiskPerTrade && config.maxRiskPerTrade > 0 ? config.maxRiskPerTrade : null;
}

export function calculatePlanAdherence(plan: PsychologyPlan | null, trades: PsychologyTrade[]): PlanAdherence {
  const hasPlan = Boolean(plan);
  const closed = trades.filter(trade => clean(trade.result) !== "OPEN");
  const plannedRisk = finite(plan?.riskLimit) > 0 ? finite(plan?.riskLimit) : null;
  const actualRisk = closed.reduce((sum, trade) => sum + Math.max(0, finite(trade.risk)), 0);
  const plannedSessions = stringList(plan?.sessionFocus);
  const actualSessions = Array.from(new Set(closed.map(trade => clean(trade.session)).filter(Boolean)));
  const unplannedTrades = closed.filter(trade => classifyPlanStatus(trade) === "UNPLANNED").length;
  const assessments = closed.map(trade => classifyTradeProcess(trade));
  const violations = assessments.reduce((sum, assessment) => sum + assessment.violations.length, 0);
  const notes: string[] = [];
  const components: { label: string; value: number | null }[] = [];

  const plannedTrades = plan?.maxTrades ?? null;
  if (plannedTrades) {
    const adherence = closed.length <= plannedTrades ? 100 : clamp(100 - (closed.length - plannedTrades) * 25);
    components.push({ label: "Trade count", value: adherence });
    if (closed.length > plannedTrades) notes.push(`${closed.length} executed vs ${plannedTrades} planned.`);
  }
  if (plannedRisk != null) {
    const adherence = actualRisk <= plannedRisk ? 100 : clamp(100 - (actualRisk - plannedRisk) / plannedRisk * 100);
    components.push({ label: "Risk", value: adherence });
    if (actualRisk > plannedRisk) notes.push(`Risk used ${round(actualRisk, 2)} vs ${round(plannedRisk, 2)} planned.`);
  }
  if (hasPlan && plannedSessions.length && actualSessions.length) {
    const adherence = clamp(closed.filter(trade => plannedSessions.includes(clean(trade.session))).length / closed.length * 100);
    components.push({ label: "Session", value: adherence });
    if (adherence < 100) notes.push(`Sessions traded: ${actualSessions.join(", ")}.`);
  }
  if (hasPlan && closed.length) {
    const adherence = clamp((closed.length - unplannedTrades) / closed.length * 100);
    components.push({ label: "Planned entries", value: adherence });
    if (unplannedTrades) notes.push(`${unplannedTrades} unplanned ${unplannedTrades === 1 ? "entry" : "entries"}.`);
  }
  const followed = parseChecklist(plan?.rulesFollowed).filter(item => item.label || item.text || item.id);
  if (followed.length) {
    components.push({ label: "Rule checklist", value: clamp(followed.filter(item => item.checked).length / followed.length * 100) });
  }
  const available = components.filter(component => component.value != null) as { label: string; value: number }[];
  return {
    plannedTrades,
    actualTrades: closed.length,
    plannedRisk,
    actualRisk: round(actualRisk, 2),
    plannedSessions,
    actualSessions,
    plannedFocus: clean(plan?.behavioralFocus) || null,
    unplannedTrades,
    violations,
    adherence: available.length ? round(available.reduce((sum, component) => sum + component.value, 0) / available.length) : null,
    components,
    notes,
  };
}

const EMOTION_KEYWORDS: { key: string; pattern: RegExp }[] = [
  { key: "FOMO", pattern: /fomo|fear of missing|chase/i },
  { key: "Revenge", pattern: /revenge|get it back|recover/i },
  { key: "Overconfidence", pattern: /overconfident|over confidence|cocky|invincible/i },
  { key: "Frustration", pattern: /frustrat|angry|anger|annoyed|gussa/i },
  { key: "Anxiety", pattern: /anxious|anxiety|nervous|worried|dar/i },
  { key: "Calm", pattern: /calm|relaxed|steady|focused|composed/i },
  { key: "Tired", pattern: /tired|exhausted|sleepy|drained/i },
  { key: "Neutral", pattern: /neutral|okay|fine|normal/i },
];

export function classifyEmotionText(value: unknown): string | null {
  const text = [clean(value)].filter(Boolean).join(" ");
  if (!text) return null;
  const match = EMOTION_KEYWORDS.find(entry => entry.pattern.test(text));
  return match ? match.key : text;
}

export function dominantEmotion(trades: PsychologyTrade[], plan: PsychologyPlan | null) {
  const counts = new Map<string, number>();
  const add = (value: unknown) => {
    for (const entry of stringList(value)) {
      const label = classifyEmotionText(entry);
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  };
  for (const trade of trades) {
    add(trade.emotionBefore);
    add(trade.emotionDuring);
    add(trade.emotionAfter);
  }
  add(plan?.emotionStart);
  add(plan?.emotionEnd);
  add(plan?.emotionalState);
  if (!counts.size) return null;
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/** Percentage of an evaluable sample that passed a rule. Null means "not evaluated". */
function componentFrom(passes: number, sample: number, violations = sample - passes): ComponentScore {
  if (sample <= 0) return { score: null, sample: 0, violations: 0 };
  return { score: round(clamp(passes / sample * 100)), sample, violations: Math.max(0, violations) };
}

export function calculateDisciplineScore(components: Record<DisciplineComponent, ComponentScore>, weights: Record<DisciplineComponent, number> = DEFAULT_DISCIPLINE_WEIGHTS) {
  const entries = (Object.keys(DEFAULT_DISCIPLINE_WEIGHTS) as DisciplineComponent[]).map(key => ({
    key,
    label: DISCIPLINE_COMPONENT_LABELS[key],
    value: components[key].score,
    sample: components[key].sample,
    violations: components[key].violations,
    weight: Math.max(0, weights[key] ?? 0),
  }));
  const evaluable = entries.filter(entry => entry.value != null && entry.weight > 0);
  const weightTotal = evaluable.reduce((sum, entry) => sum + entry.weight, 0);
  const score = weightTotal > 0 ? round(evaluable.reduce((sum, entry) => sum + (entry.value ?? 0) * entry.weight, 0) / weightTotal) : null;
  return {
    score,
    breakdown: entries.map(entry => ({ ...entry, effectiveWeight: weightTotal > 0 && entry.value != null && entry.weight > 0 ? round(entry.weight / weightTotal * 100) : 0 })),
    evaluableWeight: weightTotal,
    note: weightTotal > 0 && weightTotal < 100 ? "Components without data are excluded and the remaining weights are renormalised." : null,
  };
}

export type DisciplineScore = ReturnType<typeof calculateDisciplineScore>;

function buildSession(input: { day: string; trades: PsychologyTrade[]; plan: PsychologyPlan | null }, config: BehaviorConfig): TraderSession {
  const { day, plan, trades } = input;
  const closed = trades.filter(trade => clean(trade.result) !== "OPEN");
  const openCount = trades.length - closed.length;
  const pnl = closed.reduce((sum, trade) => sum + finite(trade.pnl), 0);
  const totalRisk = closed.reduce((sum, trade) => sum + Math.max(0, finite(trade.risk)), 0);
  const riskCeiling = resolveRiskCeiling(plan, config);
  const plannedSessions = stringList(plan?.sessionFocus);
  const maxTrades = plan?.maxTrades ?? config.maxTradesPerDay ?? null;

  const assessments = closed.map((trade, index) => {
    const previous = index > 0 ? closed[index - 1] : null;
    return classifyTradeProcess(trade, {
      riskCeiling,
      plannedSessions,
      hasPlan: Boolean(plan),
      tradeOrdinal: index + 1,
      maxTrades,
      previousWasLoss: previous ? clean(previous.result) === "LOSS" : false,
    });
  });

  const classificationCounts: Record<TradeClassification, number> = { GOOD_WIN: 0, BAD_WIN: 0, GOOD_LOSS: 0, BAD_LOSS: 0, NOT_EVALUATED: 0 };
  for (const assessment of assessments) classificationCounts[assessment.classification] += 1;

  const tags = Array.from(new Set(assessments.flatMap(assessment => assessment.tags)));
  const violations = Array.from(new Set(assessments.flatMap(assessment => assessment.violations)));

  const evaluated = assessments.filter(assessment => !assessment.notEvaluated);
  const riskPasses = evaluated.filter(assessment => (assessment.riskAdherence ?? 100) >= 80).length;
  const riskSample = evaluated.filter(assessment => assessment.riskAdherence != null).length;
  const setupPasses = evaluated.filter(assessment => (assessment.setupAdherence ?? 100) >= 80).length;
  const setupSample = evaluated.filter(assessment => assessment.setupAdherence != null).length;
  const executionPasses = evaluated.filter(assessment => (assessment.executionAdherence ?? 100) >= 80).length;
  const executionSample = evaluated.filter(assessment => assessment.executionAdherence != null).length;
  const planPasses = evaluated.filter(assessment => assessment.planStatus !== "UNPLANNED" && assessment.violations.length === 0).length;

  // Overtrading is only measurable where the session had a trade ceiling.
  const overtradingControl: ComponentScore = maxTrades == null || !closed.length
    ? { score: null, sample: 0, violations: 0 }
    : closed.length <= maxTrades && !violations.includes("OVERTRADING")
      ? { score: 100, sample: 1, violations: 0 }
      : { score: 0, sample: 1, violations: 1 };

  const reviewed = hasSessionReview(plan);
  const behavioralTriggers = parsePsychologyTriggers(plan?.psychologyTriggers);
  const objectiveStatus = parseBehavioralObjectiveStatus(plan?.behavioralObjectiveStatus);
  const behavioralReviewed = Boolean(objectiveStatus || behavioralTriggers.length || parsePostSessionBehavioralReview(plan?.postSessionBehavioralReview));
  const journalHabit: ComponentScore = plan
    ? { score: reviewed ? 100 : 60, sample: 1, violations: reviewed ? 0 : 1 }
    : { score: null, sample: 0, violations: 0 };

  const emotionalTriggers = tags.filter(tag => MISTAKE_BY_TAG[tag].category === "EMOTIONAL" && MISTAKE_BY_TAG[tag].violation);
  const hasPsychologySignal = emotionalTriggers.length > 0 || Boolean(plan?.emotionalState) || closed.some(trade => clean(trade.emotionBefore) || clean(trade.emotionDuring) || clean(trade.emotionAfter));
  const psychologicalControl: ComponentScore = hasPsychologySignal
    ? { score: emotionalTriggers.length ? 0 : 100, sample: 1, violations: emotionalTriggers.length ? 1 : 0 }
    : { score: null, sample: 0, violations: 0 };

  const components: Record<DisciplineComponent, ComponentScore> = {
    risk: { score: componentFrom(riskPasses, riskSample).score, sample: riskSample, violations: riskSample - riskPasses },
    plan: componentFrom(planPasses, evaluated.length, evaluated.length - planPasses),
    setup: { score: componentFrom(setupPasses, setupSample).score, sample: setupSample, violations: setupSample - setupPasses },
    execution: { score: componentFrom(executionPasses, executionSample).score, sample: executionSample, violations: executionSample - executionPasses },
    overtrading: overtradingControl,
    journal: journalHabit,
    psychology: psychologicalControl,
  };

  const discipline = calculateDisciplineScore(components).score;

  return {
    day,
    plan,
    trades,
    closed,
    openCount,
    pnl: round(pnl, 2),
    wins: closed.filter(trade => clean(trade.result) === "WIN").length,
    losses: closed.filter(trade => clean(trade.result) === "LOSS").length,
    breakEven: closed.filter(trade => clean(trade.result) === "BREAK_EVEN").length,
    totalRisk: round(totalRisk, 2),
    assessments,
    classificationCounts,
    tags,
    violations,
    unplannedTrades: assessments.filter(assessment => assessment.planStatus === "UNPLANNED").length,
    behavioralFocus: clean(plan?.behavioralFocus) || null,
    emotionalState: clean(plan?.emotionalState) || null,
    dominantEmotion: dominantEmotion(closed, plan),
    reviewed,
    behavioralReviewed,
    behavioralTriggers,
    objectiveStatus,
    lesson: clean(plan?.lessons) || null,
    planAdherence: calculatePlanAdherence(plan, closed),
    components,
    discipline,
  };
}

export function buildTraderSessions(trades: PsychologyTrade[], plans: PsychologyPlan[] = [], configInput: Partial<BehaviorConfig> = {}): TraderSession[] {
  const config: BehaviorConfig = { ...DEFAULT_BEHAVIOR_CONFIG, ...configInput };
  return groupTradingSessions(trades, plans).map(entry => buildSession(entry, config)).filter(session => session.trades.length > 0 || session.plan);
}

/* ------------------------------------------------------------------ *
 * Behavioral P&L
 * ------------------------------------------------------------------ */

export type BehavioralPnl = {
  totalPnl: number;
  processCompliantPnl: number;
  ruleViolationPnl: number;
  /** Trades with no behavioural evidence; their P&L is reported separately. */
  notEvaluatedPnl: number;
  complianceRate: number | null;
  sample: number;
  evaluated: number;
  notEvaluated: number;
  note: string;
};

/**
 * Splits the saved P&L into a process-compliant bucket and a rule-violation
 * bucket. This is analysis only: the underlying trades and account P&L are
 * never modified.
 */
export function calculateBehavioralPnl(trades: PsychologyTrade[], plans: PsychologyPlan[] = [], configInput: Partial<BehaviorConfig> = {}): BehavioralPnl {
  const config: BehaviorConfig = { ...DEFAULT_BEHAVIOR_CONFIG, ...configInput };
  const sessions = buildTraderSessions(trades, plans, config);
  let totalPnl = 0;
  let processCompliantPnl = 0;
  let ruleViolationPnl = 0;
  let notEvaluatedPnl = 0;
  let evaluated = 0;
  let notEvaluated = 0;
  let compliant = 0;
  for (const session of sessions) {
    session.assessments.forEach((assessment, index) => {
      const pnl = finite(session.closed[index]?.pnl);
      totalPnl += pnl;
      if (assessment.notEvaluated) { notEvaluatedPnl += pnl; notEvaluated += 1; return; }
      evaluated += 1;
      if (assessment.processCompliant) { compliant += 1; processCompliantPnl += pnl; }
      else ruleViolationPnl += pnl;
    });
  }
  return {
    totalPnl: round(totalPnl, 2),
    processCompliantPnl: round(processCompliantPnl, 2),
    ruleViolationPnl: round(ruleViolationPnl, 2),
    notEvaluatedPnl: round(notEvaluatedPnl, 2),
    complianceRate: pct(compliant, evaluated),
    sample: evaluated + notEvaluated,
    evaluated,
    notEvaluated,
    note: "Behavioural P&L is a process analysis of the saved trade P&L. It never changes the account P&L.",
  };
}

/* ------------------------------------------------------------------ *
 * Streaks
 * ------------------------------------------------------------------ */

export type DisciplineStreaks = {
  risk: number;
  noRevenge: number;
  noFomo: number;
  planAdherence: number;
  noOvertrading: number;
  journal: number;
  riskLabel: string;
};

function streak(sessions: TraderSession[], holds: (session: TraderSession) => boolean, evaluable: (session: TraderSession) => boolean) {
  let count = 0;
  for (const session of [...sessions].reverse()) {
    if (!evaluable(session)) continue;
    if (holds(session)) count += 1;
    else break;
  }
  return count;
}

export function calculateStreaks(sessions: TraderSession[], configInput: Partial<BehaviorConfig> = {}): DisciplineStreaks {
  const config: BehaviorConfig = { ...DEFAULT_BEHAVIOR_CONFIG, ...configInput };
  const ordered = [...sessions].sort((a, b) => a.day.localeCompare(b.day));
  const active = (session: TraderSession) => session.closed.length > 0;
  const risk = streak(ordered, session => !session.violations.some(tag => tag === "OVERSIZED" || tag === "REMOVED_SL" || tag === "MOVED_SL") && session.assessments.every(assessment => assessment.notEvaluated || (assessment.riskAdherence ?? 100) >= 80), active);
  const noRevenge = streak(ordered, session => !session.tags.includes("REVENGE"), active);
  const noFomo = streak(ordered, session => !session.tags.includes("FOMO"), active);
  const planAdherence = streak(ordered, session => (session.planAdherence.adherence ?? 0) >= config.planAdherenceTarget && session.unplannedTrades === 0, session => Boolean(session.plan) && session.closed.length > 0);
  const noOvertrading = streak(ordered, session => {
    const maxTrades = session.plan?.maxTrades ?? config.maxTradesPerDay ?? null;
    if (maxTrades == null) return !session.tags.includes("OVERTRADING");
    return session.closed.length <= maxTrades && !session.tags.includes("OVERTRADING");
  }, active);
  const journal = streak(ordered, session => session.reviewed, session => Boolean(session.plan) || session.closed.length > 0);
  return { risk, noRevenge, noFomo, planAdherence, noOvertrading, journal, riskLabel: `${risk} session${risk === 1 ? "" : "s"} without breaking risk rules.` };
}

/* ------------------------------------------------------------------ *
 * Readiness + cooldown
 * ------------------------------------------------------------------ */

export type PsychologyCheckin = {
  emotionalState?: string | null;
  energyLevel?: number | null;
  focusLevel?: number | null;
  confidenceLevel?: number | null;
  stressLevel?: number | null;
};

export const EMOTIONAL_STATES = ["Calm", "Neutral", "Anxious", "Frustrated", "Overconfident", "Tired"] as const;

const EMOTIONAL_STATE_SCORE: Record<string, number> = { calm: 100, neutral: 85, anxious: 55, frustrated: 40, overconfident: 50, tired: 40 };

export type TradingReadiness = {
  score: number | null;
  band: "HIGH" | "MODERATE" | "LOW" | "UNKNOWN";
  guidance: string;
  components: { label: string; value: number | null }[];
};

/**
 * Non-medical trading readiness score built only from the check-in the trader
 * saved. It guides, it never blocks: no mood can forbid trading.
 */
export function calculateTradingReadiness(checkin: PsychologyCheckin | null | undefined): TradingReadiness {
  if (!checkin) return { score: null, band: "UNKNOWN", guidance: "No pre-session check-in saved yet. A 20-second check-in improves the review.", components: [] };
  const scale = (value: number | null | undefined, invert = false) => {
    if (value == null || clean(value) === "" || !Number.isFinite(Number(value))) return null;
    const bounded = Math.min(5, Math.max(1, Number(value)));
    return round((invert ? 6 - bounded : bounded) / 5 * 100);
  };
  const stateKey = clean(checkin.emotionalState).toLowerCase();
  const components = [
    { label: "Emotional state", value: stateKey && EMOTIONAL_STATE_SCORE[stateKey] != null ? EMOTIONAL_STATE_SCORE[stateKey] : classifyEmotionText(checkin.emotionalState) ? 70 : null },
    { label: "Energy", value: scale(checkin.energyLevel) },
    { label: "Focus", value: scale(checkin.focusLevel) },
    { label: "Confidence", value: scale(checkin.confidenceLevel) },
    { label: "Stress", value: scale(checkin.stressLevel, true) },
  ];
  const available = components.filter((component): component is { label: string; value: number } => component.value != null);
  if (!available.length) return { score: null, band: "UNKNOWN", guidance: "No pre-session check-in saved yet. A 20-second check-in improves the review.", components };
  const score = round(available.reduce((sum, component) => sum + component.value, 0) / available.length);
  const band = score >= 75 ? "HIGH" : score >= 55 ? "MODERATE" : "LOW";
  const guidance = band === "HIGH"
    ? "Readiness is in your normal range. Trade your plan as written."
    : band === "MODERATE"
      ? "Readiness is mixed. Favour your highest-quality setup and keep size at plan."
      : "Readiness is low. Consider reducing size, or wait for a high-quality setup instead of forcing activity.";
  return { score, band, guidance, components };
}

export type CooldownState = {
  status: "CLEAR" | "COOLDOWN" | "SESSION_COMPLETE";
  consecutiveLosses: number;
  dailyLoss: number;
  message: string;
  actions: string[];
};

export function evaluateCooldown(sessions: TraderSession[], configInput: Partial<BehaviorConfig> = {}): CooldownState {
  const config: BehaviorConfig = { ...DEFAULT_BEHAVIOR_CONFIG, ...configInput };
  const ordered = [...sessions].sort((a, b) => a.day.localeCompare(b.day));
  const latest = ordered.at(-1) ?? null;
  const consecutiveLosses = (() => {
    let count = 0;
    for (const session of [...ordered].reverse()) {
      for (const trade of [...session.closed].reverse()) {
        if (clean(trade.result) === "LOSS") count += 1;
        else if (clean(trade.result) === "WIN" || clean(trade.result) === "BREAK_EVEN") return count;
      }
      if (count > 0) break;
    }
    return count;
  })();
  const dailyLoss = latest ? Math.min(0, latest.pnl) : 0;
  if (config.maxDailyLoss != null && config.maxDailyLoss > 0 && dailyLoss <= -Math.abs(config.maxDailyLoss)) {
    return {
      status: "SESSION_COMPLETE",
      consecutiveLosses,
      dailyLoss: round(dailyLoss, 2),
      message: "Today's objective is no longer recovery. Protect your process and capital.",
      actions: ["Close the platform for the day.", "Save the execution review and one lesson.", "Reconfirm the next session's plan before trading again."],
    };
  }
  if (consecutiveLosses >= Math.max(1, config.cooldownAfterLosses)) {
    return {
      status: "COOLDOWN",
      consecutiveLosses,
      dailyLoss: round(dailyLoss, 2),
      message: `${consecutiveLosses} consecutive losses recorded. Take the configured reset before the next entry.`,
      actions: ["Step away from the chart.", "Review the previous trade.", "Identify the emotion that was present.", "Reconfirm today's plan before any new entry."],
    };
  }
  return { status: "CLEAR", consecutiveLosses, dailyLoss: round(dailyLoss, 2), message: "No cooldown is active.", actions: [] };
}

/* ------------------------------------------------------------------ *
 * Behavioural focus + weekly psychology
 * ------------------------------------------------------------------ */

export type BehavioralFocus = {
  key: BehavioralTag;
  label: string;
  score: number;
  target: number;
  trend: number | null;
  sessions: number;
  recommendation: string;
  others: { key: BehavioralTag; label: string; score: number }[];
};

/**
 * Control score for one behaviour across a window of sessions.
 * A session with no matching tag counts as a session without that breach, so a
 * clean week reports 100 rather than an undefined "no data" value.
 */
function controlScoreFor(tagsPerSession: BehavioralTag[][], tag: BehavioralTag) {
  if (!tagsPerSession.length) return null;
  const breached = tagsPerSession.filter(session => session.includes(tag)).length;
  return round(clamp(100 - breached / tagsPerSession.length * 100));
}

/**
 * The behaviour tags a session is judged against. A session that executed more
 * trades than its own plan allowed is treated as an overtrading breach because
 * the saved plan and the saved trade count are both facts, not inferences.
 */
export function sessionBehaviorTags(session: TraderSession, config: BehaviorConfig): BehavioralTag[] {
  const maxTrades = session.plan?.maxTrades ?? config.maxTradesPerDay ?? null;
  const overCap = maxTrades != null && session.closed.length > maxTrades;
  if (!overCap || session.tags.includes("OVERTRADING")) return session.tags;
  return [...session.tags, "OVERTRADING"];
}

export function calculateBehavioralFocus(sessions: TraderSession[], configInput: Partial<BehaviorConfig> = {}): BehavioralFocus | null {
  const config: BehaviorConfig = { ...DEFAULT_BEHAVIOR_CONFIG, ...configInput };
  const ordered = [...sessions].sort((a, b) => a.day.localeCompare(b.day)).filter(session => session.closed.length > 0);
  if (!ordered.length) return null;
  const window = ordered.slice(-config.focusWindow);
  const previous = ordered.slice(-config.focusWindow * 2, -config.focusWindow);
  const tagsPerSession = window.map(session => sessionBehaviorTags(session, config));
  const previousTags = previous.map(session => sessionBehaviorTags(session, config));
  const scored = BEHAVIOR_TAG_FOCUS.map(configuration => {
    const score = controlScoreFor(tagsPerSession, configuration.key);
    return score == null ? null : { ...configuration, score };
  }).filter((entry): entry is (typeof BEHAVIOR_TAG_FOCUS)[number] & { score: number } => entry !== null);
  if (!scored.length) {
    const fallback = BEHAVIOR_TAG_FOCUS[0];
    return { key: fallback.key, label: "Process consistency", score: 100, target: config.focusTarget, trend: null, sessions: window.length, recommendation: "Keep saving a focus per session so recurring patterns can be measured.", others: [] };
  }
  const ranked = [...scored].sort((a, b) => a.score - b.score || a.key.localeCompare(b.key));
  const primary = ranked[0];
  const trendBase = controlScoreFor(previousTags, primary.key);
  return {
    key: primary.key,
    label: primary.label,
    score: primary.score,
    target: Math.min(100, Math.max(config.focusTarget, primary.score + 15)),
    trend: trendBase == null || !previous.length ? null : round(primary.score - trendBase),
    sessions: window.length,
    recommendation: primary.recommendation,
    others: ranked.slice(1, 4).map(entry => ({ key: entry.key, label: entry.label, score: entry.score })),
  };
}

export type WeeklyPsychology = {
  window: number;
  sessions: number;
  discipline: number | null;
  planAdherence: number | null;
  riskDiscipline: number | null;
  emotionalControl: number | null;
  fomo: number | null;
  revenge: number | null;
  overtrading: number | null;
  observed: string[];
  biggestImprovement: { label: string; delta: number } | null;
  biggestWeakness: { label: string; value: number } | null;
  nextWeekFocus: string | null;
  pnl: number;
  behavioralPnl: { processCompliantPnl: number; ruleViolationPnl: number };
};

export function calculateWeeklyPsychology(sessions: TraderSession[], configInput: Partial<BehaviorConfig> = {}): WeeklyPsychology {
  const config: BehaviorConfig = { ...DEFAULT_BEHAVIOR_CONFIG, ...configInput };
  const ordered = [...sessions].sort((a, b) => a.day.localeCompare(b.day)).filter(session => session.closed.length > 0 || session.plan);
  const window = ordered.slice(-config.weeklyWindow);
  const previous = ordered.slice(-config.weeklyWindow * 2, -config.weeklyWindow);
  const average = (values: (number | null)[]) => {
    const available = values.filter((value): value is number => value != null);
    return available.length ? round(available.reduce((sum, value) => sum + value, 0) / available.length) : null;
  };
  const tagsPer = window.map(session => sessionBehaviorTags(session, config));
  const prevTags = previous.map(session => sessionBehaviorTags(session, config));
  const metrics: { label: string; key: string; value: number | null }[] = [
    { label: "Discipline", key: "discipline", value: average(window.map(session => session.discipline)) },
    { label: "Plan adherence", key: "plan", value: average(window.map(session => session.planAdherence.adherence)) },
    { label: "Risk discipline", key: "risk", value: average(window.map(session => session.components.risk.score)) },
    { label: "Emotional control", key: "psychology", value: average(window.map(session => session.components.psychology.score)) },
    { label: "FOMO", key: "fomo", value: controlScoreFor(tagsPer, "FOMO") },
    { label: "Revenge", key: "revenge", value: controlScoreFor(tagsPer, "REVENGE") },
    { label: "Overtrading", key: "overtrading", value: controlScoreFor(tagsPer, "OVERTRADING") },
  ];
  const previousByKey = new Map<string, number | null>([
    ["discipline", average(previous.map(session => session.discipline))],
    ["plan", average(previous.map(session => session.planAdherence.adherence))],
    ["risk", average(previous.map(session => session.components.risk.score))],
    ["psychology", average(previous.map(session => session.components.psychology.score))],
    ["fomo", controlScoreFor(prevTags, "FOMO")],
    ["revenge", controlScoreFor(prevTags, "REVENGE")],
    ["overtrading", controlScoreFor(prevTags, "OVERTRADING")],
  ]);
  const deltas = metrics
    .map(metric => {
      const before = previousByKey.get(metric.key) ?? null;
      if (metric.value == null || before == null) return null;
      return { label: metric.label, delta: round(metric.value - before) };
    })
    .filter((entry): entry is { label: string; delta: number } => entry !== null);
  const improvement = [...deltas].sort((a, b) => b.delta - a.delta)[0] ?? null;
  const weakness = metrics.filter((metric): metric is { label: string; key: string; value: number } => metric.value != null).sort((a, b) => a.value - b.value)[0] ?? null;
  const focus = calculateBehavioralFocus(sessions, config);
  const observed: string[] = [];
  const violationSessions = window.filter(session => session.violations.length > 0).length;
  if (window.length) observed.push(`${window.length} session${window.length === 1 ? "" : "s"} reviewed in this window.`);
  if (violationSessions) observed.push(`${violationSessions} of those sessions recorded at least one behavioural rule break.`);
  else if (window.length) observed.push("No behavioural rule breaks were tagged in this window.");
  const previousPnl = previous.reduce((sum, session) => sum + session.pnl, 0);
  const windowPnl = window.reduce((sum, session) => sum + session.pnl, 0);
  if (previous.length) observed.push(`P&L moved from ${round(previousPnl, 2)} in the previous window to ${round(windowPnl, 2)}.`);
  return {
    window: config.weeklyWindow,
    sessions: window.length,
    discipline: metrics[0].value,
    planAdherence: metrics[1].value,
    riskDiscipline: metrics[2].value,
    emotionalControl: metrics[3].value,
    fomo: metrics[4].value,
    revenge: metrics[5].value,
    overtrading: metrics[6].value,
    observed,
    biggestImprovement: improvement && improvement.delta > 0 ? improvement : null,
    biggestWeakness: weakness ? { label: weakness.label, value: weakness.value } : null,
    nextWeekFocus: focus?.recommendation ?? null,
    pnl: round(windowPnl, 2),
    behavioralPnl: {
      processCompliantPnl: round(window.reduce((sum, session) => sum + session.assessments.reduce((inner, assessment, index) => inner + (assessment.processCompliant ? finite(session.closed[index]?.pnl) : 0), 0), 0), 2),
      ruleViolationPnl: round(window.reduce((sum, session) => sum + session.assessments.reduce((inner, assessment, index) => inner + (assessment.processCompliant === false ? finite(session.closed[index]?.pnl) : 0), 0), 0), 2),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

export type IdentityConsistency = {
  statement: string;
  score: number | null;
  checks: { label: string; value: number | null; sessions: number }[];
};

export function calculateIdentityConsistency(statement: string | null | undefined, sessions: TraderSession[]): IdentityConsistency {
  const text = clean(statement);
  const window = [...sessions].sort((a, b) => a.day.localeCompare(b.day)).slice(-10).filter(session => session.closed.length > 0);
  if (!text) return { statement: "", score: null, checks: [] };
  const average = (values: (number | null)[]) => {
    const available = values.filter((value): value is number => value != null);
    return available.length ? round(available.reduce((sum, value) => sum + value, 0) / available.length) : null;
  };
  const losses = window.flatMap(session => session.assessments.filter((_, index) => clean(session.closed[index]?.result) === "LOSS"));
  const checks = [
    { label: "Followed risk rules", value: average(window.map(session => session.components.risk.score)), sessions: window.length },
    { label: "Followed the plan", value: average(window.map(session => session.planAdherence.adherence)), sessions: window.length },
    { label: "Accepted valid losses", value: losses.length ? round(losses.filter(assessment => assessment.processCompliant).length / losses.length * 100) : null, sessions: losses.length },
    { label: "Avoided revenge", value: controlScoreFor(window.map(session => session.tags), "REVENGE"), sessions: window.length },
  ];
  return { statement: text, score: average(checks.map(check => check.value)), checks };
}

/* ------------------------------------------------------------------ *
 * Recurring patterns (observed facts vs interpretation)
 * ------------------------------------------------------------------ */

export type BehavioralInsight = { kind: "OBSERVED" | "INTERPRETATION"; text: string };

/**
 * Flags journal rows that share an MT5 ticket. The database enforces uniqueness,
 * so a duplicate here means a synchronisation race reached the client; reporting
 * it is safer than silently dropping or double-counting someone's P&L.
 */
export function detectDuplicateTickets(trades: PsychologyTrade[]): string[] {
  const seen = new Map<string, number>();
  for (const trade of trades) {
    const ticket = clean(trade.mt5Ticket);
    if (!ticket) continue;
    seen.set(ticket, (seen.get(ticket) ?? 0) + 1);
  }
  return Array.from(seen.entries()).filter(([, count]) => count > 1).map(([ticket, count]) => `MT5 ticket ${ticket} appears ${count} times in the loaded journal.`);
}

export function calculateRecurringPatterns(sessions: TraderSession[]): BehavioralInsight[] {
  const ordered = [...sessions].sort((a, b) => a.day.localeCompare(b.day)).filter(session => session.closed.length > 0);
  const insights: BehavioralInsight[] = [];
  if (ordered.length < 2) return insights;
  const recent = ordered.slice(-5);
  const unplanned = recent.flatMap(session => session.assessments.map((assessment, index) => ({ assessment, trade: session.closed[index], session })));
  const unplannedTrades = unplanned.filter(entry => entry.assessment.planStatus === "UNPLANNED");
  const afterLoss = unplannedTrades.filter(entry => {
    const index = ordered.findIndex(session => session.day === entry.session.day);
    const previousSession = index > 0 ? ordered[index - 1] : null;
    const lastPrevious = previousSession?.closed.at(-1);
    return lastPrevious ? clean(lastPrevious.result) === "LOSS" : false;
  });
  if (unplannedTrades.length) {
    insights.push({ kind: "OBSERVED", text: `${afterLoss.length} of your last ${unplannedTrades.length} unplanned ${unplannedTrades.length === 1 ? "trade" : "trades"} followed a losing trade.` });
    if (afterLoss.length >= 3 && afterLoss.length / unplannedTrades.length >= 0.5) {
      insights.push({ kind: "INTERPRETATION", text: "Possible pattern: revenge behaviour after a loss. Confirm against your own journal before acting on it." });
    }
  }
  const sessionsWithFomo = recent.filter(session => session.tags.includes("FOMO"));
  if (sessionsWithFomo.length) {
    const sessionsList = sessionsWithFomo.map(session => session.day).join(", ");
    insights.push({ kind: "OBSERVED", text: `FOMO was tagged on ${sessionsWithFomo.length} of the last ${recent.length} sessions (${sessionsList}).` });
    const afterMissed = sessionsWithFomo.filter(session => /missed|skipped|no trade|wait/i.test(clean(session.plan?.whatWentWrong ?? "") + " " + clean(session.lesson))).length;
    if (afterMissed >= 2) insights.push({ kind: "INTERPRETATION", text: "Your FOMO tags most often follow a session where a setup was missed." });
  }
  const sessionCounts = recent.map(session => session.closed.length);
  const average = sessionCounts.reduce((sum, value) => sum + value, 0) / sessionCounts.length;
  const maxTrades = recent.map(session => session.plan?.maxTrades ?? null).filter((value): value is number => value != null);
  if (maxTrades.length) {
    const above = recent.filter(session => session.plan?.maxTrades != null && session.closed.length > session.plan.maxTrades).length;
    insights.push({ kind: "OBSERVED", text: `${above} of the last ${recent.length} sessions exceeded the planned daily trade count (average ${round(average)} trades per session).` });
  }
  return insights;
}

/* ------------------------------------------------------------------ *
 * Composition
 * ------------------------------------------------------------------ */

export type DevelopmentInput = {
  trades: PsychologyTrade[];
  plans?: PsychologyPlan[];
  identityStatement?: string | null;
  weights?: Partial<Record<DisciplineComponent, number>>;
  config?: Partial<BehaviorConfig>;
  /** Today's pre-session check-in (plan fields or the journal profile). */
  checkin?: PsychologyCheckin | null;
  /** The day key to treat as "today" for cooldown / focus messaging. Defaults to the latest session. */
  today?: string | null;
};

export type TraderDevelopmentReport = {
  sessions: TraderSession[];
  latest: TraderSession | null;
  today: TraderSession | null;
  discipline: DisciplineScore;
  riskDiscipline: number | null;
  planAdherence: number | null;
  emotionalControl: number | null;
  behavioralPnl: BehavioralPnl;
  streaks: DisciplineStreaks;
  focus: BehavioralFocus | null;
  weekly: WeeklyPsychology;
  readiness: TradingReadiness;
  cooldown: CooldownState;
  identity: IdentityConsistency;
  insights: BehavioralInsight[];
  counts: Record<TradeClassification, number>;
  totals: { sessions: number; trades: number; unplanned: number; violations: number; reviewed: number };
};

export function analyzeTraderDevelopment(input: DevelopmentInput): TraderDevelopmentReport {
  const config: BehaviorConfig = { ...DEFAULT_BEHAVIOR_CONFIG, ...input.config };
  const sessions = buildTraderSessions(input.trades, input.plans ?? [], config);
  const ordered = [...sessions].sort((a, b) => a.day.localeCompare(b.day));
  const weighted = (pick: (session: TraderSession) => number | null) => {
    const values = ordered.map(pick).filter((value): value is number => value != null);
    return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  };
  const counts: Record<TradeClassification, number> = { GOOD_WIN: 0, BAD_WIN: 0, GOOD_LOSS: 0, BAD_LOSS: 0, NOT_EVALUATED: 0 };
  for (const session of ordered) for (const key of Object.keys(counts) as TradeClassification[]) counts[key] += session.classificationCounts[key];
  const checkin: PsychologyCheckin | null = input.checkin ?? (ordered.at(-1)?.plan
    ? {
        emotionalState: ordered.at(-1)?.plan?.emotionalState,
        energyLevel: ordered.at(-1)?.plan?.energyLevel,
        focusLevel: ordered.at(-1)?.plan?.focusLevel,
        confidenceLevel: ordered.at(-1)?.plan?.confidenceLevel,
        stressLevel: ordered.at(-1)?.plan?.stressLevel,
      }
    : null);
  return {
    sessions: ordered,
    latest: ordered.at(-1) ?? null,
    today: input.today ? ordered.find(session => session.day === input.today) ?? null : ordered.at(-1) ?? null,
    discipline: calculateDisciplineScore({
      risk: averageComponent(ordered, "risk"),
      plan: averageComponent(ordered, "plan"),
      setup: averageComponent(ordered, "setup"),
      execution: averageComponent(ordered, "execution"),
      overtrading: averageComponent(ordered, "overtrading"),
      journal: averageComponent(ordered, "journal"),
      psychology: averageComponent(ordered, "psychology"),
    }, { ...DEFAULT_DISCIPLINE_WEIGHTS, ...input.weights }),
    riskDiscipline: weighted(session => session.components.risk.score),
    planAdherence: weighted(session => session.planAdherence.adherence),
    emotionalControl: weighted(session => session.components.psychology.score),
    behavioralPnl: calculateBehavioralPnl(input.trades, input.plans ?? [], config),
    streaks: calculateStreaks(ordered, config),
    focus: calculateBehavioralFocus(ordered, config),
    weekly: calculateWeeklyPsychology(ordered, config),
    readiness: calculateTradingReadiness(checkin),
    cooldown: evaluateCooldown(ordered, config),
    identity: calculateIdentityConsistency(input.identityStatement, ordered),
    insights: calculateRecurringPatterns(ordered),
    counts,
    totals: {
      sessions: ordered.length,
      trades: ordered.reduce((sum, session) => sum + session.closed.length, 0),
      unplanned: ordered.reduce((sum, session) => sum + session.unplannedTrades, 0),
      violations: ordered.reduce((sum, session) => sum + session.violations.length, 0),
      reviewed: ordered.filter(session => session.reviewed).length,
    },
  };
}

function averageComponent(sessions: TraderSession[], key: DisciplineComponent): ComponentScore {
  const entries = sessions.map(session => session.components[key]).filter(entry => entry.score != null);
  if (!entries.length) return { score: null, sample: 0, violations: 0 };
  const sample = entries.reduce((sum, entry) => sum + entry.sample, 0);
  const violations = entries.reduce((sum, entry) => sum + entry.violations, 0);
  const weightedSum = entries.reduce((sum, entry) => sum + (entry.score ?? 0) * Math.max(1, entry.sample), 0);
  const weightTotal = entries.reduce((sum, entry) => sum + Math.max(1, entry.sample), 0);
  return { score: round(weightedSum / weightTotal), sample, violations };
}
