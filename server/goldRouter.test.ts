import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  ensureAccount: vi.fn(),
  getJournal: vi.fn(),
  getOwnedAccount: vi.fn(),
  ownsTrade: vi.fn(),
  storagePut: vi.fn(),
  hasImageSignature: vi.fn(() => true),
  syncStoredMt5: vi.fn(),
  removeAccountAtomic: vi.fn(),
  clearAccountJournalDataAtomic: vi.fn(),
  recordGoalAlertsAtomic: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./goldDb", () => ({
  ensureAccount: mocks.ensureAccount,
  getJournal: mocks.getJournal,
  getOwnedAccount: mocks.getOwnedAccount,
  ownsTrade: mocks.ownsTrade,
}));
vi.mock("./storage", () => ({ storagePut: mocks.storagePut, hasImageSignature: mocks.hasImageSignature }));
vi.mock("./mt5Db", () => ({ getMt5History: vi.fn(), getMt5Workspace: vi.fn(), syncStoredMt5PositionsToTradeLog: mocks.syncStoredMt5 }));
vi.mock("./atomicOperations", () => ({ removeAccountAtomic: mocks.removeAccountAtomic, clearAccountJournalDataAtomic: mocks.clearAccountJournalDataAtomic, recordGoalAlertsAtomic: mocks.recordGoalAlertsAtomic }));

import { goldRouter } from "./goldRouter";

const user = { id: 7, openId: "journal-owner", role: "user" };
const validTrade = { accountId: 12, tradeDate: Date.now(), session: "London", direction: "BUY", result: "WIN", patienceScore: null, risk: null, reward: null, pnl: 0 };
const limitedRows = (rows: unknown[]) => ({ from: () => ({ where: () => ({ limit: vi.fn().mockResolvedValue(rows) }) }) });

describe("Gold Journal protected server workflows", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.hasImageSignature.mockReturnValue(true);
  });

  it("bootstraps an authenticated user through the account helper", async () => {
    mocks.ensureAccount.mockResolvedValue({ id: 12, name: "Primary Account" });
    const caller = goldRouter.createCaller({ user } as any);
    await expect(caller.journal.bootstrap()).resolves.toMatchObject({ id: 12, name: "Primary Account" });
    expect(mocks.ensureAccount).toHaveBeenCalledWith(7);
  });

  it("reconciles stored MT5 positions before returning an owned journal", async () => {
    mocks.getOwnedAccount.mockResolvedValue({ id: 12, userId: 7, name: "Primary Account" });
    mocks.syncStoredMt5.mockResolvedValue(4);
    mocks.getJournal.mockResolvedValue({ activeAccount: { id: 12 }, trades: [{ id: 1, result: "WIN" }] });
    const caller = goldRouter.createCaller({ user } as any);

    await expect(caller.journal.get({ accountId: 12 })).resolves.toMatchObject({ activeAccount: { id: 12 }, trades: [{ result: "WIN" }] });
    expect(mocks.syncStoredMt5).toHaveBeenCalledWith(7, 12);
    expect(mocks.getJournal).toHaveBeenCalledWith(7, 12);
  });

  it("blocks anonymous account mutations before a database call", async () => {
    const caller = goldRouter.createCaller({ user: null } as any);
    await expect(caller.accounts.create({ name: "Restricted Account", startingBalance: 0 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("does not allow a non-owned account to be renamed", async () => {
    mocks.getOwnedAccount.mockRejectedValue(new Error("That trading account is unavailable."));
    const caller = goldRouter.createCaller({ user } as any);
    await expect(caller.accounts.rename({ accountId: 99, name: "Other trader account" })).rejects.toThrow("unavailable");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("renames the explicitly selected owned account rather than a fallback account", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    mocks.getOwnedAccount.mockResolvedValue({ id: 24, userId: 7, name: "Selected account" });
    mocks.getDb.mockResolvedValue({ update });
    const caller = goldRouter.createCaller({ user } as any);

    await expect(caller.accounts.rename({ accountId: 24, name: "Renamed selected account" })).resolves.toEqual({ success: true });
    expect(mocks.getOwnedAccount).toHaveBeenCalledWith(7, 24);
    expect(update).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("requires explicit confirmation before an account-removal workflow can start", async () => {
    const caller = goldRouter.createCaller({ user } as any);
    await expect(caller.accounts.remove({ accountId: 24, confirmed: false } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.getOwnedAccount).not.toHaveBeenCalled();
  });

  it("chooses a remaining owned account after confirmed removal", async () => {
    mocks.getOwnedAccount.mockResolvedValue({ id: 24, userId: 7, name: "Account to remove" });
    mocks.removeAccountAtomic.mockResolvedValue({ success: true, replacementAccountId: 25 });
    const caller = goldRouter.createCaller({ user } as any);

    await expect(caller.accounts.remove({ accountId: 24, confirmed: true })).resolves.toEqual({ success: true, replacementAccountId: 25 });
    expect(mocks.getOwnedAccount).toHaveBeenCalledWith(7, 24);
    expect(mocks.removeAccountAtomic).toHaveBeenCalledWith(7, 24);
  });

  it("does not return the internal storage key after an owned screenshot upload", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    mocks.ownsTrade.mockResolvedValue({ id: 11, userId: 7 });
    mocks.storagePut.mockResolvedValue({ key: "gold-journal/7/trades/internal-key.jpg", url: "https://signed.example.test/screenshot" });
    mocks.getDb.mockResolvedValue({ update: () => ({ set: () => ({ where }) }) });
    const caller = goldRouter.createCaller({ user } as any);

    await expect(caller.trades.uploadScreenshot({ tradeId: 11, fileName: "setup.jpg", mimeType: "image/jpeg", base64: `data:image/jpeg;base64,${"A".repeat(100)}` })).resolves.toEqual({ url: "https://signed.example.test/screenshot" });
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("blocks an anonymous trade mutation before ownership validation", async () => {
    const caller = goldRouter.createCaller({ user: null } as any);
    await expect(caller.trades.delete({ tradeId: 11 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mocks.ownsTrade).not.toHaveBeenCalled();
  });

  it("removes a saved protocol only after account ownership and explicit confirmation", async () => {
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    mocks.getOwnedAccount.mockResolvedValue({ id: 12, userId: 7, name: "Primary Account" });
    mocks.getDb.mockResolvedValue({ delete: () => ({ where: deleteWhere }) });
    const caller = goldRouter.createCaller({ user } as any);

    await expect(caller.plans.remove({ accountId: 12, planId: 44, confirmed: true })).resolves.toEqual({ success: true });
    expect(mocks.getOwnedAccount).toHaveBeenCalledWith(7, 12);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-owned trade update before writing data", async () => {
    mocks.ownsTrade.mockRejectedValue(new Error("That trade is unavailable."));
    const caller = goldRouter.createCaller({ user } as any);
    await expect(caller.trades.update({ ...validTrade, tradeId: 11 })).rejects.toThrow("unavailable");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("records a new account-scoped goal alert once and deduplicates its type plus cycle key", async () => {
    const select = vi.fn().mockImplementation(() => limitedRows([]));
    mocks.getOwnedAccount.mockResolvedValue({ id: 12, userId: 7 });
    mocks.recordGoalAlertsAtomic.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mocks.getDb.mockResolvedValue({ select });
    const caller = goldRouter.createCaller({ user } as any);

    await expect(caller.notifications.recordGoalAlerts({ accountId: 12, alerts: [{ goalId: 88, status: "AT_RISK", cycleKey: "DAILY-2026-08-12", message: "Loss ceiling is near." }] })).resolves.toEqual({ recorded: 1 });
    expect(mocks.recordGoalAlertsAtomic).toHaveBeenCalledWith(7, 12, [{ goalId: 88, type: "GOAL_AT_RISK_88_DAILY-2026-08-12", message: "Loss ceiling is near." }]);

    await expect(caller.notifications.recordGoalAlerts({ accountId: 12, alerts: [{ goalId: 88, status: "AT_RISK", cycleKey: "DAILY-2026-08-12", message: "Loss ceiling is near." }] })).resolves.toEqual({ recorded: 0 });
    expect(mocks.recordGoalAlertsAtomic).toHaveBeenCalledTimes(2);
  });

  it("skips goal alerts for inactive or notification-disabled rules", async () => {
    const select = vi.fn().mockImplementation(() => limitedRows([]));
    mocks.getOwnedAccount.mockResolvedValue({ id: 12, userId: 7 });
    mocks.recordGoalAlertsAtomic.mockResolvedValue(0);
    mocks.getDb.mockResolvedValue({ select });
    const caller = goldRouter.createCaller({ user } as any);

    await expect(caller.notifications.recordGoalAlerts({ accountId: 12, alerts: [{ goalId: 89, status: "BREACHED", cycleKey: "DAILY-2026-08-12", message: "Inactive ceiling breached." }, { goalId: 90, status: "MET", cycleKey: "DAILY-2026-08-12", message: "Silent target achieved." }] })).resolves.toEqual({ recorded: 0 });
    expect(mocks.recordGoalAlertsAtomic).toHaveBeenCalledTimes(1);
  });

  it("reconciles stored MT5 positions into only the owned account with an active connection", async () => {
    mocks.getOwnedAccount.mockResolvedValue({ id: 12, userId: 7 });
    mocks.getDb.mockResolvedValue({ select: () => limitedRows([{ id: 44 }]) });
    mocks.syncStoredMt5.mockResolvedValue(3);
    const caller = goldRouter.createCaller({ user } as any);

    await expect(caller.mt5.syncTradeLog({ accountId: 12 })).resolves.toEqual({ synchronized: 3 });
    expect(mocks.getOwnedAccount).toHaveBeenCalledWith(7, 12);
    expect(mocks.syncStoredMt5).toHaveBeenCalledWith(7, 12);
  });

  it("blocks MT5 Trade Log reconciliation when the requested account is not owned", async () => {
    mocks.getOwnedAccount.mockRejectedValue(new Error("That trading account is unavailable."));
    const caller = goldRouter.createCaller({ user } as any);

    await expect(caller.mt5.syncTradeLog({ accountId: 99 })).rejects.toThrow("unavailable");
    expect(mocks.syncStoredMt5).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("rejects a connection mutation when the connection is unavailable to the explicitly selected account", async () => {
    const update = vi.fn();
    mocks.getOwnedAccount.mockResolvedValue({ id: 25, userId: 7, name: "Second account" });
    mocks.getDb.mockResolvedValue({ select: () => limitedRows([]), update });
    const caller = goldRouter.createCaller({ user } as any);
    await expect(caller.mt5.setConnectionActive({ accountId: 25, connectionId: 44, active: false })).rejects.toThrow("unavailable");
    expect(mocks.getOwnedAccount).toHaveBeenCalledWith(7, 25);
    expect(update).not.toHaveBeenCalled();
  });

  it("replaces a missing-orphaned MT5 connection row by account id without deleting journal history", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    mocks.getOwnedAccount.mockResolvedValue({ id: 12, userId: 7, name: "Primary account" });
    mocks.getDb.mockResolvedValue({ select: () => limitedRows([{ id: 44, userId: 999 }]), update });
    const caller = goldRouter.createCaller({ user } as any);

    const result = await caller.mt5.replaceConnection({ accountId: 12, label: "Primary account Live", brokerUtcOffsetMinutes: 180 });

    expect(result).toMatchObject({ id: 44, replaced: true });
    expect(result.apiKey).toHaveLength(43);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      accountId: 12,
      label: "Primary account Live",
      active: true,
      brokerUtcOffsetMinutes: 180,
      lastPing: null,
      lastContactAt: null,
      balance: null,
      equity: null,
    }));
    expect(set.mock.calls[0][0].apiKey).not.toBe(result.apiKey);
    expect(where).toHaveBeenCalled();
  });

  it("retires an owned MT5 connection instead of deleting the account-scoped record", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const remove = vi.fn();
    mocks.getOwnedAccount.mockResolvedValue({ id: 12, userId: 7, name: "Primary account" });
    mocks.getDb.mockResolvedValue({ select: () => limitedRows([{ id: 44, userId: 7, accountId: 12, retiredAt: null }]), update, delete: remove });
    const caller = goldRouter.createCaller({ user } as any);

    await expect(caller.mt5.deleteConnection({ accountId: 12, connectionId: 44, confirmed: true })).resolves.toEqual({ success: true, retired: true });

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ active: false, retiredReason: "USER_RETIRED", retiredAt: expect.any(Date) }));
    expect(remove).not.toHaveBeenCalled();
  });

  it("requires a replacement key before a retired MT5 connection can become active again", async () => {
    const update = vi.fn();
    mocks.getOwnedAccount.mockResolvedValue({ id: 12, userId: 7, name: "Primary account" });
    mocks.getDb.mockResolvedValue({ select: () => limitedRows([{ id: 44, userId: 7, accountId: 12, retiredAt: new Date("2026-08-23T00:00:00Z") }]), update });
    const caller = goldRouter.createCaller({ user } as any);

    await expect(caller.mt5.setConnectionActive({ accountId: 12, connectionId: 44, active: true })).rejects.toThrow("Issue a replacement key");
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a goal mutation when the goal belongs to another user", async () => {
    mocks.getDb.mockResolvedValue({ select: () => limitedRows([]) });
    const caller = goldRouter.createCaller({ user } as any);
    await expect(caller.goals.delete({ goalId: 901 })).rejects.toThrow("unavailable");
  });
});
