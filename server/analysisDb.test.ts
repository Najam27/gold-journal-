import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), getOwnedAccount: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb }));
vi.mock("./goldDb", () => ({ getOwnedAccount: mocks.getOwnedAccount }));

import { getAccountAnalysis } from "./analysisDb";

const row = { id: 1, tradeDate: "2026-01-01T00:00:00Z", result: "WIN", pnl: "10.00", risk: "10.00", reward: "20.00", session: "London", timeframe: "M5", level: "Support", setupQuality: "A", direction: "BUY", notes: null, screenshotKey: null };

describe("account analysis data loader", () => {
  beforeEach(() => { mocks.getDb.mockReset(); mocks.getOwnedAccount.mockReset().mockResolvedValue({ id: 7, userId: 3 }); });

  it("loads only owned account rows and returns deterministic aggregates instead of raw trades", async () => {
    const builder: any = {};
    builder.from = vi.fn(() => builder); builder.where = vi.fn(() => builder); builder.orderBy = vi.fn(() => builder); builder.limit = vi.fn().mockResolvedValue([row]);
    mocks.getDb.mockResolvedValue({ select: vi.fn(() => builder) });
    const result = await getAccountAnalysis(3, 7);
    expect(mocks.getOwnedAccount).toHaveBeenCalledWith(3, 7);
    expect(result.overview.sample).toBe(1);
    expect(result.overview.netPnl).toBe(10);
    expect((result as any).trades).toBeUndefined();
    expect(builder.limit).toHaveBeenCalledWith(1000);
  });

  it("stops before querying when the account ownership chain rejects", async () => {
    mocks.getOwnedAccount.mockRejectedValue(new Error("That trading account is unavailable."));
    const select = vi.fn(); mocks.getDb.mockResolvedValue({ select });
    await expect(getAccountAnalysis(3, 99)).rejects.toThrow("unavailable");
    expect(select).not.toHaveBeenCalled();
  });
});
