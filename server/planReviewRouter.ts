import { z } from "zod";
import { dailyPlans } from "../drizzle/schema";
import { getOwnedAccount } from "./goldDb";
import { getDb } from "./db";
import { protectedProcedure, router } from "./_core/trpc";
import { getPktDateKey, pktDateToTimestamp } from "@shared/pktDate";

/**
 * The daily plan's behavioural close-out.
 *
 * `plans.save` owns the planning fields, the pre-session check-in, and the
 * after-close scorecard. This router owns the four things that only exist once
 * a session has been reviewed — which saved plan the draft was copied from, the
 * psychological triggers, the verdict on the day's single behavioural
 * objective, and the short post-session behavioural review — plus the trigger
 * history the Psychology page reads back.
 *
 * It is a separate, idempotent upsert on the same ownership key rather than a
 * second plan table: one row per (user, account, Pakistan-time day) stays the
 * single record, and a replayed save can never create a duplicate plan. Nothing
 * here touches planning fields, trade P&L, or another account's rows.
 */

const optionalText = (max = 400) => z.string().trim().max(max).optional().default("");
const timestampInput = z.number().finite().int().positive().max(8_640_000_000_000_000);
const behaviouralVerdictInput = z.enum(["YES", "PARTIALLY", "NO"]);
const canonicalPktPlanDate = (timestamp: number) => new Date(pktDateToTimestamp(getPktDateKey(timestamp)));

const postSessionBehaviouralReviewInput = z
  .object({
    followPlan: behaviouralVerdictInput.nullable().optional().default(null),
    nextSessionChange: optionalText(400),
    triggerAction: optionalText(400),
  })
  .strict();

const planReviewInput = z.object({
  accountId: z.number().int().positive(),
  planDate: timestampInput,
  copiedFromPlanId: z.number().int().positive().nullable().optional().default(null),
  copiedFromPlanDate: timestampInput.nullable().optional().default(null),
  psychologyTriggers: z.array(z.string().trim().min(1).max(60)).max(20).optional().default([]),
  primaryPsychologyTrigger: optionalText(60),
  behavioralObjectiveStatus: behaviouralVerdictInput.nullable().optional().default(null),
  postSessionBehavioralReview: postSessionBehaviouralReviewInput.nullable().optional().default(null),
});

/**
 * True when the write failed only because migration 0026 has not been applied
 * yet. The client keeps the planning half of the save and tells the trader that
 * trigger history is not being stored, instead of reporting a failed plan.
 */
export function isMissingPlanReviewColumn(error: unknown) {
  const code = String((error as { supabaseCode?: string } | null)?.supabaseCode ?? "");
  if (code === "PGRST204" || code === "42703") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /could not find the '.*' column|column .* does not exist/i.test(message);
}

export const PLAN_REVIEW_MIGRATION_HINT = "Trigger history and copy provenance need the 0026 plan migration applied to this Supabase project. Everything else in today's plan is saved.";

export const planReviewRouter = router({
  planReview: router({
    save: protectedProcedure.input(planReviewInput).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await getDb();
      if (!db) throw new Error("Supabase database is unavailable. Please retry shortly.");
      // An unanswered review is stored as NULL, so "not reviewed" stays
      // distinguishable from "reviewed and clean".
      const review = input.postSessionBehavioralReview && (input.postSessionBehavioralReview.followPlan || input.postSessionBehavioralReview.nextSessionChange || input.postSessionBehavioralReview.triggerAction)
        ? input.postSessionBehavioralReview
        : null;
      const values = {
        userId: ctx.user.id,
        accountId: input.accountId,
        planDate: canonicalPktPlanDate(input.planDate),
        copiedFromPlanId: input.copiedFromPlanId,
        copiedFromPlanDate: input.copiedFromPlanDate ? canonicalPktPlanDate(input.copiedFromPlanDate) : null,
        psychologyTriggers: input.psychologyTriggers.length ? input.psychologyTriggers : null,
        primaryPsychologyTrigger: input.primaryPsychologyTrigger,
        behavioralObjectiveStatus: input.behavioralObjectiveStatus,
        postSessionBehavioralReview: review,
      };
      try {
        await db.insert(dailyPlans).values(values).onConflictDoUpdate({ target: [dailyPlans.userId, dailyPlans.accountId, dailyPlans.planDate], set: values });
        return { success: true as const, stored: true as const, warning: null };
      } catch (error) {
        if (!isMissingPlanReviewColumn(error)) throw error;
        return { success: true as const, stored: false as const, warning: PLAN_REVIEW_MIGRATION_HINT };
      }
    }),
  }),
});
