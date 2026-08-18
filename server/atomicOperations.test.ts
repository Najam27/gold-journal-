import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./supabaseAdmin", () => ({ getSupabaseAdmin: () => ({ rpc }) }));

import { clearAccountJournalDataAtomic, recordGoalAlertsAtomic, removeAccountAtomic, syncMt5PositionAtomic } from "./atomicOperations";

describe("atomic Supabase operation wrappers", () => {
  beforeEach(() => rpc.mockReset());

  it("forwards account clear arguments to the real database function", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const resetAt = new Date("2026-08-18T00:00:00.000Z");
    await expect(clearAccountJournalDataAtomic(7, 12, resetAt)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("gj_clear_account_journal_data", { target_user_id: 7, target_account_id: 12, target_reset_at: resetAt.toISOString() });
  });

  it("returns the replacement account from atomic removal", async () => {
    rpc.mockResolvedValue({ data: [{ replacement_account_id: 25 }], error: null });
    await expect(removeAccountAtomic(7, 24)).resolves.toEqual({ success: true, replacementAccountId: 25 });
  });

  it("forwards a bounded goal-alert batch to the database function", async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    const alerts = [{ goalId: 88, type: "GOAL_AT_RISK_88_DAILY-2026-08-12", message: "Loss ceiling is near." }];
    await expect(recordGoalAlertsAtomic(7, 12, alerts)).resolves.toBe(1);
    expect(rpc).toHaveBeenCalledWith("gj_record_goal_alerts", { target_user_id: 7, target_account_id: 12, alerts });
  });

  it("fails closed when the atomic function reports an error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "migration missing" } });
    await expect(syncMt5PositionAtomic(7, 12, { ticket: "42" })).rejects.toThrow("atomic operation sync MT5 position failed");
  });
});
