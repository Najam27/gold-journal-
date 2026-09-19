import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), getOwnedAccount: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./goldDb", () => ({ getOwnedAccount: mocks.getOwnedAccount }));

import { PLAN_REVIEW_MIGRATION_HINT, isMissingPlanReviewColumn, planReviewRouter } from "./planReviewRouter";

function createContext(userId = 7): TrpcContext {
  return { user: { id: userId, openId: `user-${userId}`, email: `user${userId}@example.com`, name: "User", loginMethod: "supabase", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() }, req: { headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

const write = () => {
  const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  mocks.getDb.mockResolvedValue({ insert });
  return { insert, values, onConflictDoUpdate };
};

const planDate = Date.parse("2026-09-19T00:00:00+05:00");

describe("planReview.save", () => {
  beforeEach(() => {
    mocks.getDb.mockReset();
    mocks.getOwnedAccount.mockReset();
    mocks.getOwnedAccount.mockResolvedValue({ id: 3, userId: 7, name: "Primary Account" });
  });

  it("writes the behavioural loop onto the owning account's plan row only", async () => {
    const { values } = write();
    const result = await planReviewRouter.createCaller(createContext()).planReview.save({
      accountId: 3,
      planDate,
      psychologyTriggers: ["FOMO", "IMPATIENCE"],
      primaryPsychologyTrigger: "FOMO",
      behavioralObjectiveStatus: "PARTIALLY",
      postSessionBehavioralReview: { followPlan: "PARTIALLY", nextSessionChange: "Wait for the close", triggerAction: "Chased the second entry" },
      copiedFromPlanId: 5,
      copiedFromPlanDate: Date.parse("2026-09-18T00:00:00+05:00"),
    });

    expect(result.stored).toBe(true);
    expect(mocks.getOwnedAccount).toHaveBeenCalledWith(7, 3);
    const payload = values.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.userId).toBe(7);
    expect(payload.accountId).toBe(3);
    expect(payload.psychologyTriggers).toEqual(["FOMO", "IMPATIENCE"]);
    expect(payload.primaryPsychologyTrigger).toBe("FOMO");
    expect(payload.behavioralObjectiveStatus).toBe("PARTIALLY");
    expect(payload.copiedFromPlanId).toBe(5);
    // The day is stored at the canonical Pakistan-time noon instant, so two saves
    // of the same day can never create two rows.
    expect((payload.planDate as Date).toISOString()).toBe(new Date(Date.parse("2026-09-19T12:00:00+05:00")).toISOString());
  });

  it("stores an unanswered review as NULL so an empty review is not a clean review", async () => {
    const { values } = write();
    await planReviewRouter.createCaller(createContext()).planReview.save({
      accountId: 3,
      planDate,
      psychologyTriggers: [],
      primaryPsychologyTrigger: "",
      behavioralObjectiveStatus: null,
      postSessionBehavioralReview: { followPlan: null, nextSessionChange: "", triggerAction: "" },
    });
    const payload = values.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.psychologyTriggers).toBeNull();
    expect(payload.postSessionBehavioralReview).toBeNull();
    expect(payload.behavioralObjectiveStatus).toBeNull();
    expect(payload.copiedFromPlanId).toBeNull();
    expect(payload.copiedFromPlanDate).toBeNull();
  });

  it("refuses to write to an account the caller does not own", async () => {
    write();
    mocks.getOwnedAccount.mockRejectedValueOnce(new Error("That trading account is unavailable."));
    await expect(planReviewRouter.createCaller(createContext()).planReview.save({ accountId: 99, planDate })).rejects.toThrow("That trading account is unavailable.");
  });

  it("keeps the saved plan usable when the 0026 migration has not been applied yet", async () => {
    const onConflictDoUpdate = vi.fn().mockRejectedValue(Object.assign(new Error("Could not find the 'psychologyTriggers' column of 'gj_daily_plans' in the schema cache"), { supabaseCode: "PGRST204" }));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    mocks.getDb.mockResolvedValue({ insert: vi.fn(() => ({ values })) });

    const result = await planReviewRouter.createCaller(createContext()).planReview.save({ accountId: 3, planDate, psychologyTriggers: ["FOMO"] });

    expect(result).toEqual({ success: true, stored: false, warning: PLAN_REVIEW_MIGRATION_HINT });
  });

  it("still reports a genuine database failure", async () => {
    const onConflictDoUpdate = vi.fn().mockRejectedValue(new Error("connection reset"));
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    mocks.getDb.mockResolvedValue({ insert: vi.fn(() => ({ values })) });
    await expect(planReviewRouter.createCaller(createContext()).planReview.save({ accountId: 3, planDate })).rejects.toThrow("connection reset");
  });
});

describe("isMissingPlanReviewColumn", () => {
  it("recognises only the missing-column signatures", () => {
    expect(isMissingPlanReviewColumn(Object.assign(new Error("nope"), { supabaseCode: "PGRST204" }))).toBe(true);
    expect(isMissingPlanReviewColumn(Object.assign(new Error("nope"), { supabaseCode: "42703" }))).toBe(true);
    expect(isMissingPlanReviewColumn(new Error("column \"behavioralObjectiveStatus\" does not exist"))).toBe(true);
    expect(isMissingPlanReviewColumn(new Error("connection reset"))).toBe(false);
    expect(isMissingPlanReviewColumn(null)).toBe(false);
  });
});
