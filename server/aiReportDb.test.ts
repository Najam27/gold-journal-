import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnalysis } from "@shared/analysisEngine";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb }));

import { persistAiOutcome } from "./aiReportDb";

const report = {
  executiveSummary: "No deterministic evidence is available yet.", strongestEdges: [], weakestContexts: [], sessionAnalysis: [], timeframeAnalysis: [], levelAnalysis: [], setupAnalysis: [],
  winLossDifferences: { winProfile: [], lossProfile: [], keyDifferences: [], potentialLeaks: [] }, behavioralLeaks: [], edgeHypotheses: [], experiments: [],
  playbook: { bestConditions: [], weakConditions: [], bestSession: "Insufficient evidence", bestTimeframe: "Insufficient evidence", bestLevels: [], bestSetups: [], bestDirection: "Insufficient evidence", commonFailureConditions: [], tradeManagementLeaks: [], currentEdgeHypotheses: [], nextExperiments: [] },
  dataQuality: { missing: [], warnings: [] }, warnings: [],
};

describe("AI report persistence", () => {
  beforeEach(() => mocks.getDb.mockReset());

  it("does not require a database when AI is unavailable", async () => {
    const analysis = buildAnalysis([]);
    const result = await persistAiOutcome(9, 42, analysis, { available: false, cached: false, model: null, report: null });
    expect(result.persisted).toBe(false);
    expect(result.reportId).toBeNull();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("persists an immutable account-scoped snapshot with a deterministic fingerprint", async () => {
    const insertValues: any[] = [];
    const insertChain: any = {
      values(value: unknown) { insertValues.push(value); return this; },
      onConflictDoNothing: vi.fn(function (this: any) { return this; }),
      returning: vi.fn().mockResolvedValue([{ id: 101 }]),
    };
    const db = { insert: vi.fn(() => insertChain) };
    mocks.getDb.mockResolvedValue(db);
    const result = await persistAiOutcome(9, 42, buildAnalysis([]), { available: true, cached: false, model: "test-model", report });
    expect(result.persisted).toBe(true);
    expect(result.reportId).toBe(101);
    expect(insertValues[0]).toMatchObject({ userId: 9, accountId: 42, model: "test-model" });
    expect(insertValues[0].dataFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(insertChain.onConflictDoNothing).toHaveBeenCalled();
  });
});
