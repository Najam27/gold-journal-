import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAccountAnalysis: vi.fn(), persistAiReport: vi.fn(), consumeRateLimit: vi.fn(() => true) }));
vi.mock("./analysisDb", () => ({ getAccountAnalysis: mocks.getAccountAnalysis }));
vi.mock("./aiReportDb", () => ({
  persistAiReport: mocks.persistAiReport,
  listAiReports: vi.fn(async () => []),
  listAiExperiments: vi.fn(async () => []),
  updateAiExperiment: vi.fn(async () => ({ success: true })),
}));
vi.mock("./rateLimit", () => ({ consumeRateLimit: mocks.consumeRateLimit }));

import { goldRouter } from "./goldRouter";

const user = { id: 17, openId: "auth-user-17", role: "user" };
const deterministic = { version: "analysis-v1", period: { start: null, end: null, sample: 0 } } as any;
const emptyReport = {
  executiveSummary: "Evidence is limited.",
  strongestEdges: [], weakestContexts: [], sessionAnalysis: [], timeframeAnalysis: [], levelAnalysis: [], setupAnalysis: [],
  winLossDifferences: { winProfile: [], lossProfile: [], keyDifferences: [], potentialLeaks: [] },
  behavioralLeaks: [], edgeHypotheses: [], experiments: [],
  playbook: { bestConditions: [], weakConditions: [], bestSession: "Insufficient evidence", bestTimeframe: "Insufficient evidence", bestLevels: [], bestSetups: [], bestDirection: "Insufficient evidence", commonFailureConditions: [], tradeManagementLeaks: [], currentEdgeHypotheses: [], nextExperiments: [] },
  dataQuality: { missing: [], warnings: [] }, warnings: [],
};

describe("authenticated analysis procedures", () => {
  beforeEach(() => {
    mocks.getAccountAnalysis.mockReset().mockResolvedValue(deterministic);
    mocks.persistAiReport.mockReset().mockResolvedValue({ persisted: true, reportId: 5, dataFingerprint: "abc" });
    mocks.consumeRateLimit.mockReset().mockReturnValue(true);
  });

  it("passes the verified application user and requested account to deterministic analysis", async () => {
    const caller = goldRouter.createCaller({ user } as any);
    await expect(caller.analysis.get({ accountId: 44, filters: {} })).resolves.toBe(deterministic);
    expect(mocks.getAccountAnalysis).toHaveBeenCalledWith(17, 44, {});
  });

  it("keeps deterministic analysis behind authentication", async () => {
    const anonymous = goldRouter.createCaller({ user: null } as any);
    await expect(anonymous.analysis.get({ accountId: 44, filters: {} })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("stores a browser-produced report without any server-side AI call", async () => {
    const caller = goldRouter.createCaller({ user } as any);
    await expect(caller.analysis.saveAiReport({ accountId: 44, filters: {}, model: "gemini-3.8-flash", report: emptyReport as never })).resolves.toEqual({ success: true, reportId: 5, persisted: true });
    expect(mocks.persistAiReport).toHaveBeenCalledWith(17, 44, deterministic, "gemini-3.8-flash", expect.objectContaining({ executiveSummary: "Evidence is limited." }));
    expect(mocks.consumeRateLimit).not.toHaveBeenCalled();
  });

  it("rejects a malformed report shape before touching the database", async () => {
    const caller = goldRouter.createCaller({ user } as any);
    await expect(caller.analysis.saveAiReport({ accountId: 44, filters: {}, model: "gemini-3.8-flash", report: { executiveSummary: "only a summary" } as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.persistAiReport).not.toHaveBeenCalled();
  });
});
