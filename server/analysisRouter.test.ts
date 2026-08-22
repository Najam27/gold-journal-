import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAccountAnalysis: vi.fn(), getOpenRouterStatus: vi.fn(), consumeRateLimit: vi.fn(() => true) }));
vi.mock("./analysisDb", () => ({ getAccountAnalysis: mocks.getAccountAnalysis }));
vi.mock("./analysisAi", () => ({ getOpenRouterStatus: mocks.getOpenRouterStatus }));
vi.mock("./rateLimit", () => ({ consumeRateLimit: mocks.consumeRateLimit }));

import { goldRouter } from "./goldRouter";

const user = { id: 17, openId: "auth-user-17", role: "user" };
const deterministic = { version: "analysis-v1", period: { start: null, end: null, sample: 0 } } as any;

describe("authenticated analysis procedures", () => {
  beforeEach(() => { mocks.getAccountAnalysis.mockReset(); mocks.getOpenRouterStatus.mockReset().mockResolvedValue({ configured: false, vaultAvailable: true, model: null }); mocks.consumeRateLimit.mockReset().mockReturnValue(true); });

  it("passes the verified application user and requested account to deterministic analysis", async () => {
    mocks.getAccountAnalysis.mockResolvedValue(deterministic);
    const caller = goldRouter.createCaller({ user } as any);
    await expect(caller.analysis.get({ accountId: 44, filters: {} })).resolves.toBe(deterministic);
    expect(mocks.getAccountAnalysis).toHaveBeenCalledWith(17, 44, {});
  });

  it("keeps AI behind authentication and the server procedure", async () => {
    mocks.getAccountAnalysis.mockResolvedValue(deterministic);
    const caller = goldRouter.createCaller({ user } as any);
    const result = await caller.analysis.ai({ accountId: 44, filters: {} });
    expect(result.ai.available).toBe(false);
    expect(result.ai.message).toContain("Add your OpenRouter key in Options");
    const anonymous = goldRouter.createCaller({ user: null } as any);
    await expect(anonymous.analysis.ai({ accountId: 44, filters: {} })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("stops AI requests at the server rate limit before loading account data", async () => {
    mocks.consumeRateLimit.mockReturnValue(false);
    const caller = goldRouter.createCaller({ user } as any);
    await expect(caller.analysis.ai({ accountId: 44, filters: {} })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(mocks.getAccountAnalysis).not.toHaveBeenCalled();
    expect(mocks.getOpenRouterStatus).not.toHaveBeenCalled();
  });
});
