import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnalysis } from "@shared/analysisEngine";
import { aiTestHooks, analyzeWithOpenRouter, DEFAULT_AI_TIMEOUT_MS, getOpenRouterStatus } from "./analysisAi";

const report = {
  executiveSummary: "Evidence is limited and should be treated as a hypothesis.",
  strongestEdges: [], weakestContexts: [], sessionAnalysis: [], timeframeAnalysis: [], levelAnalysis: [], setupAnalysis: [],
  winLossDifferences: { winProfile: [], lossProfile: [], keyDifferences: [], potentialLeaks: [] },
  behavioralLeaks: [], edgeHypotheses: [], experiments: [],
  playbook: { bestConditions: [], weakConditions: [], bestSession: "Insufficient evidence", bestTimeframe: "Insufficient evidence", bestLevels: [], bestSetups: [], bestDirection: "Insufficient evidence", commonFailureConditions: [], tradeManagementLeaks: [], currentEdgeHypotheses: [], nextExperiments: [] },
  dataQuality: { missing: [], warnings: [] }, warnings: [],
};
const analysis = buildAnalysis([
  { tradeDate: "2026-01-01", result: "WIN", pnl: 10, risk: 10, session: "London", timeframe: "M5", level: "Support", setupQuality: "A", direction: "BUY", notes: "PRIVATE_NOTE_SHOULD_NOT_REACH_AI" },
  { tradeDate: "2026-01-02", result: "LOSS", pnl: -5, risk: 10, session: "London", timeframe: "M5", level: "Support", setupQuality: "A", direction: "BUY" },
  { tradeDate: "2026-01-03", result: "BREAK_EVEN", pnl: 0, risk: 10, session: "London", timeframe: "M5", level: "Support", setupQuality: "A", direction: "BUY" },
]);

function providerResponse(content: unknown, status = 200) { return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), { status, headers: { "Content-Type": "application/json" } }); }

describe("server OpenRouter analysis", () => {
  beforeEach(() => { vi.restoreAllMocks(); aiTestHooks.clearCache(); process.env.OPENROUTER_API_KEY = "test-key"; process.env.OPENROUTER_MODEL = "test-model"; delete process.env.OPENROUTER_FALLBACK_MODEL; delete process.env.OPENROUTER_TIMEOUT_MS; });

  it("validates structured output, keeps the key server-side, and caches by analytics data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(report));
    vi.stubGlobal("fetch", fetchMock);
    const first = await analyzeWithOpenRouter(1, 2, analysis);
    const second = await analyzeWithOpenRouter(1, 2, analysis);
    expect(first.available).toBe(true);
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.messages[1].content).not.toContain("test-key");
    expect(request.messages[1].content).not.toContain("PRIVATE_NOTE_SHOULD_NOT_REACH_AI");
    expect(request.messages[1].content).not.toContain("screenshotKey");
    expect(request.model).toBe("test-model");
  });

  it("rejects malformed JSON and hallucinated numerical claims without breaking deterministic analysis", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(providerResponse("not json")));
    const malformed = await analyzeWithOpenRouter(1, 2, analysis);
    expect(malformed.available).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(providerResponse({ ...report, executiveSummary: "999 trades prove this edge." })));
    const hallucinated = await analyzeWithOpenRouter(1, 3, analysis);
    expect(hallucinated.available).toBe(false);
    expect(hallucinated.message).toContain("temporarily unavailable");
  });

  it("uses one configured fallback model after a primary provider failure", async () => {
    process.env.OPENROUTER_FALLBACK_MODEL = "fallback-model";
    const fetchMock = vi.fn().mockResolvedValueOnce(providerResponse(report, 404)).mockResolvedValueOnce(providerResponse(report));
    vi.stubGlobal("fetch", fetchMock);
    const result = await analyzeWithOpenRouter(1, 7, analysis);
    expect(result.available).toBe(true);
    expect(result.model).toBe("fallback-model");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("isolates provider failures and aborts timed-out requests", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("provider down")));
    const failed = await analyzeWithOpenRouter(1, 4, analysis);
    expect(failed.available).toBe(false);
    process.env.OPENROUTER_TIMEOUT_MS = "1";
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => { init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))); })));
    const timedOut = await analyzeWithOpenRouter(1, 5, analysis);
    expect(timedOut.available).toBe(false);
    expect(aiTestHooks.cacheSize()).toBe(0);
  });

  it("defaults to a bounded one-minute shared AI budget and never lets configuration exceed it", () => {
    expect(DEFAULT_AI_TIMEOUT_MS).toBe(60_000);
    expect(aiTestHooks.resolveAiTimeoutMs(undefined)).toBe(60_000);
    expect(aiTestHooks.resolveAiTimeoutMs("120000")).toBe(60_000);
    expect(aiTestHooks.resolveAiTimeoutMs("5000")).toBe(5_000);
  });

  it("reports readiness without exposing the OpenRouter secret", () => {
    expect(getOpenRouterStatus()).toEqual({ configured: true, model: "test-model", fallbackConfigured: false });
    delete process.env.OPENROUTER_API_KEY;
    expect(getOpenRouterStatus()).toEqual({ configured: false, model: "test-model", fallbackConfigured: false });
  });

  it("returns a deterministic-unavailable result when server configuration is absent", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const result = await analyzeWithOpenRouter(1, 6, analysis);
    expect(result.available).toBe(false);
    expect(result.message).toContain("not configured");
  });
});
