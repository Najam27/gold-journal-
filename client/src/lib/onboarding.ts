/**
 * "First 30 trades" guided onboarding program — progress tracking.
 *
 * Trading rationale: beginners quit journaling because the full dashboard is
 * overwhelming and logging feels like homework. A staged program (log first,
 * add the why second, review third) builds the habit before the depth, so the
 * metrics that matter — mistakes, plan adherence, weekly review — are already
 * part of the routine by the time the trader needs them.
 *
 * Everything here is pure; the UI layer only reads the phases and nextAction.
 */

import { toNumber } from "@/lib/gold";

export interface OnboardingTradeInput {
  mistake?: string | null;
  notes?: string | null;
  emotionBefore?: string | null;
  planFollowScore?: number | string | null;
}

export interface OnboardingPhase {
  id: "log" | "detail" | "review";
  title: string;
  description: string;
  target: number;
  done: number;
  complete: boolean;
}

export interface OnboardingProgress {
  totalTrades: number;
  phases: OnboardingPhase[];
  complete: boolean;
  nextAction: string;
}

const PHASE1_TARGET = 10;
const PHASE2_TARGET = 10;
const PHASE3_TARGET = 2;

function isNonEmpty(value: string | null | undefined): boolean {
  return String(value ?? "").trim().length > 0;
}

function isValidPlanScore(value: number | string | null | undefined): boolean {
  const score = Number(value);
  return Number.isFinite(score) && score >= 1 && score <= 5;
}

/**
 * A trade counts as "detailed" when the trader wrote down the why: a mistake,
 * a note, how they felt before entry, or a 1–5 plan-following score. Any one
 * of them is enough — the point is reflection, not paperwork.
 */
export function isDetailedTrade(trade: OnboardingTradeInput): boolean {
  return (
    isNonEmpty(trade.mistake) ||
    isNonEmpty(trade.notes) ||
    isNonEmpty(trade.emotionBefore) ||
    isValidPlanScore(trade.planFollowScore)
  );
}

function plural(n: number, singular: string, pluralWord?: string): string {
  return n === 1 ? singular : (pluralWord ?? `${singular}s`);
}

export function onboardingProgress(opts: {
  trades: OnboardingTradeInput[];
  weeklyReviewCount: number;
  planCount: number;
}): OnboardingProgress {
  const trades = opts.trades ?? [];
  const totalTrades = trades.length;
  const reviewCount = Math.max(0, toNumber(opts.weeklyReviewCount));
  const planCount = Math.max(0, toNumber(opts.planCount));

  const phase1Done = Math.min(totalTrades, PHASE1_TARGET);
  const phase2Done = Math.min(trades.filter(isDetailedTrade).length, PHASE2_TARGET);
  const phase3Done = (reviewCount >= 1 ? 1 : 0) + (planCount >= 1 ? 1 : 0);

  const phase1: OnboardingPhase = {
    id: "log",
    title: "Just log",
    description: "Log 10 trades — any trades. Speed matters more than detail.",
    target: PHASE1_TARGET,
    done: phase1Done,
    complete: phase1Done >= PHASE1_TARGET,
  };
  const phase2: OnboardingPhase = {
    id: "detail",
    title: "Add the why",
    description:
      "For 10 trades, add the why: note a mistake, write what you felt before entry, or rate your plan-following 1–5.",
    target: PHASE2_TARGET,
    done: phase2Done,
    complete: phase2Done >= PHASE2_TARGET,
  };
  const phase3: OnboardingPhase = {
    id: "review",
    title: "Review like a pro",
    description:
      "Complete your first weekly review and save a trading plan. This is where journaling turns into improvement.",
    target: PHASE3_TARGET,
    done: phase3Done,
    complete: phase3Done >= PHASE3_TARGET,
  };

  const phases = [phase1, phase2, phase3];
  const complete = phases.every((p) => p.complete);

  let nextAction: string;
  if (complete) {
    nextAction = "You've finished the First 30 — the habits are yours now.";
  } else if (!phase1.complete) {
    const remaining = PHASE1_TARGET - phase1Done;
    nextAction = `Log ${remaining} more ${plural(remaining, "trade")} to finish phase 1.`;
  } else if (!phase2.complete) {
    const remaining = PHASE2_TARGET - phase2Done;
    nextAction = `Add detail (mistake, notes, emotion, or plan score) to ${remaining} more ${plural(
      remaining,
      "trade",
    )} to finish phase 2.`;
  } else if (reviewCount < 1) {
    nextAction = "Complete your first weekly review to finish phase 3.";
  } else {
    nextAction = "Save your first trading plan to finish phase 3.";
  }

  return { totalTrades, phases, complete, nextAction };
}
