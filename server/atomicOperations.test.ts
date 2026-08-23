import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./supabaseAdmin", () => ({ getSupabaseAdmin: () => ({ rpc }) }));

import { clearAccountJournalDataAtomic, recordGoalAlertsAtomic, removeAccountAtomic, syncMt5PositionAtomic, touchMt5ConnectionAtomic, updateMt5AccountSummaryAtomic } from "./atomicOperations";

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

  it("uses the migration-defined position_payload RPC argument for MT5 sync", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const position = { ticket: "42", status: "CLOSED" };
    await expect(syncMt5PositionAtomic(7, 12, position)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("gj_sync_mt5_position", { target_user_id: 7, target_account_id: 12, position_payload: position });
  });

  it("requires an explicit successful-row response for the authenticated MT5 contact write", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(touchMt5ConnectionAtomic(44)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("gj_touch_mt5_connection", { target_connection_id: 44 });
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(touchMt5ConnectionAtomic(44)).rejects.toThrow("did not affect the authenticated connection");
  });

  it("writes summary facts through the confirmed connection RPC without API-key material", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(updateMt5AccountSummaryAtomic(44, {
      mt5Login: 90123456n,
      brokerServer: "Broker-Live",
      currency: "USD",
      balance: 10_000,
      equity: 10_042.5,
      margin: 250,
      freeMargin: 9_792.5,
      floatingPnl: 42.5,
      riskSymbol: "XAUUSD",
      riskTickSize: 0.1,
      riskTickValueLoss: 10,
      riskContractSize: 100,
      riskVolumeMin: 0.01,
      riskVolumeMax: 50,
      riskVolumeStep: 0.01,
    })).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("gj_update_mt5_connection_summary", expect.objectContaining({
      target_connection_id: 44,
      summary_payload: expect.objectContaining({ mt5Login: "90123456", balance: 10_000, riskSymbol: "XAUUSD" }),
    }));
    expect(JSON.stringify(rpc.mock.calls.at(-1))).not.toContain("api_key");
  });

  it("fails closed when the atomic function reports an error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "migration missing" } });
    await expect(syncMt5PositionAtomic(7, 12, { ticket: "42" })).rejects.toThrow("atomic operation sync MT5 position failed");
  });
});
