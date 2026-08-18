import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAccountAnalysis: vi.fn(), analyzeWithOpenRouter: vi.fn(), consumeRateLimit: vi.fn(() => true) }));
vi.mock("./analysisDb", () => ({ getAccountAnalysis: mocks.getAccountAnalysis }));
vi.mock("./analysisAi", () => ({ analyzeWithOpenRouter: mocks.analyzeWithOpenRouter }));
vi.mock("./rateLimit", () => ({ consumeRateLimit: mocks.consumeRateLimit }));

import { goldRouter } from "./goldRouter";

const user = { id: 17, openId: "auth-user-17", role: "user" };
const deterministic = { version: "analysis-v1", period: { start: null, end: null, sample: 0 } } as any;

describe("authenticated analysis procedures", () => {
  beforeEach(() => { mocks.getAccountAnalysis.mockReset(); mocks.analyzeWithOpenRouter.mockReset(); mocks.consumeRateLimit.mockReset().mockReturnValue(true); });

  it("passes the verified application user and requested account to deterministic analysis", async () => {
    mocks.getAccountAnalysis.mockResolvedValue(deterministic);
    const caller = goldRouter.createCaller({ user } as any);
    await expect(caller.analysis.get({ accountId: 44, filters: {} })).resolves.toBe(deterministic);
    expect(mocks.getAccountAnalysis).toHaveBeenCalledWith(17, 44, {});
  });

  it("keeps AI behind authentication and the server procedure", async () => {
    mocks.getAccountAnalysis.mockResolvedValue(deterministic);
    mocks.analyzeWithOpenRouter.mockResolvedValue({ available: false, cached: false, model: null, report: null, message: "not configured" });
    const caller = goldRouter.createCaller({ user } as any);
    const result = await caller.analysis.ai({ accountId: 44, filters: {} });
    expect(result.ai.available).toBe(false);
    expect(mocks.analyzeWithOpenRouter).toHaveBeenCalledWith(17, 44, deterministic);
    const anonymous = goldRouter.createCaller({ user: null } as any);
    await expect(anonymous.analysis.ai({ accountId: 44, filters: {} })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("stops AI requests at the server rate limit before loading account data", async () => {
    mocks.consumeRateLimit.mockReturnValue(false);
    const caller = goldRouter.createCaller({ user } as any);
    await expect(caller.analysis.ai({ accountId: 44, filters: {} })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(mocks.getAccountAnalysis).not.toHaveBeenCalled();
    expect(mocks.analyzeWithOpenRouter).not.toHaveBeenCalled();
  });
});
