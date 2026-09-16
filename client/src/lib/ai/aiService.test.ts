import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnalysis } from "@shared/analysisEngine";
import { AI_SERVICE_VERSION, analysisDataFingerprint, isUsableGeminiModelId, normalizeGeminiModelId, pickPreferredGeminiModel, rankGeminiModels, stableHash16 } from "@shared/aiCore";
import {
  AI_SETTINGS_STORAGE_KEY,
  clearAiSettings,
  memoryAiSettingsPersistence,
  readAiSettings,
  readAiSettingsView,
  resetAiSettingsPersistence,
  saveAiSettings,
  setAiSettingsPersistence,
  subscribeAiSettings,
} from "./aiStorage";
import { analyzeJournal, checkGeminiConnection, clearAiCache, coachRisk, getAvailableGeminiModels, isAiConfigured, resolveCompatibleModel, testAiConnection } from "./aiService";
import { isModelError, uiStateForErrorCode } from "./aiTypes";

const KEY = "AIza-test-only-key-0123456789abcdef";
const MODEL = "gemini-3.8-flash";

const MODELS = [
  { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] },
  { name: "models/gemini-3.5-flash", displayName: "Gemini 3.5 Flash", supportedGenerationMethods: ["generateContent"] },
  { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
];

const analysis = buildAnalysis([
  { tradeDate: "2026-01-01", result: "WIN", pnl: 10, risk: 10, session: "London", timeframe: "M5", level: "Support", setupQuality: "A", direction: "BUY", notes: "PRIVATE_NOTE_SHOULD_NOT_REACH_AI" },
  { tradeDate: "2026-01-02", result: "LOSS", pnl: -5, risk: 10, session: "London", timeframe: "M5", level: "Support", setupQuality: "A", direction: "BUY" },
]);

const report = {
  executiveSummary: "Evidence is limited and should be treated as a hypothesis.",
  strongestEdges: [], weakestContexts: [], sessionAnalysis: [], timeframeAnalysis: [], levelAnalysis: [], setupAnalysis: [],
  winLossDifferences: { winProfile: [], lossProfile: [], keyDifferences: [], potentialLeaks: [] },
  behavioralLeaks: [], edgeHypotheses: [], experiments: [],
  playbook: { bestConditions: [], weakConditions: [], bestSession: "Insufficient evidence", bestTimeframe: "Insufficient evidence", bestLevels: [], bestSetups: [], bestDirection: "Insufficient evidence", commonFailureConditions: [], tradeManagementLeaks: [], currentEdgeHypotheses: [], nextExperiments: [] },
  dataQuality: { missing: [], warnings: [] }, warnings: [],
};

const calculation = { valid: true, basis: "EQUITY" as const, capital: 10_000, freeMargin: 9_900, riskPercent: 1, riskAmount: 100, stopDistance: 5, stopTicks: 50, lossPerLot: 500, rawLots: 0.2, lots: 0.2, actualRisk: 100, riskBudgetUtilization: 100, freeMarginRiskPercent: 1.01, symbol: "XAUUSDm", currency: "USD", warnings: [], verification: ["Confirm broker values."] };

function providerResponse(content: unknown, status = 200) {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof content === "string" ? content : JSON.stringify(content) }] } }] }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function modelsResponse(models: unknown[] = MODELS, status = 200) {
  return new Response(JSON.stringify({ models }), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Google's endpoint answers a GET for the model listing and a POST for
 * generateContent. The real client makes both, so the stub routes both and the
 * `postCalls` array holds only the inference attempts.
 */
function stubGemini(post: (callIndex: number, url: string) => Response | Promise<Response>, get: () => Response | Promise<Response> = () => modelsResponse()) {
  let postIndex = 0;
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    calls.push([String(url), init]);
    if (!init || (init.method ?? "GET").toUpperCase() === "GET") return Promise.resolve(get());
    return Promise.resolve(post(postIndex++, String(url)));
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    postCalls: () => calls.filter(([, init]) => (init?.method ?? "").toUpperCase() === "POST"),
    calls,
  };
}

function signedReport(overrides: Record<string, unknown> = {}) {
  return { ...report, ...overrides };
}

beforeEach(() => {
  setAiSettingsPersistence(memoryAiSettingsPersistence());
  clearAiCache();
});

afterEach(() => {
  resetAiSettingsPersistence();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser AI settings storage", () => {
  it("reports not configured until the user stores their own key", () => {
    expect(isAiConfigured()).toBe(false);
    expect(readAiSettingsView()).toMatchObject({ configured: false, maskedKey: null, model: null });
  });

  it("stores the key locally, exposes only a masked form, and never returns it from the view", () => {
    const view = saveAiSettings({ apiKey: KEY, model: MODEL });
    expect(view.configured).toBe(true);
    expect(view.model).toBe(MODEL);
    expect(view.maskedKey).not.toBe(KEY);
    expect(view.maskedKey).toContain("••••••••");
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(readAiSettings()?.apiKey).toBe(KEY);
    expect(isAiConfigured()).toBe(true);
  });

  it("persists under the namespaced key and clears the record completely on removal", () => {
    const store = memoryAiSettingsPersistence();
    setAiSettingsPersistence(store);
    saveAiSettings({ apiKey: KEY, model: MODEL });
    expect(store.read()).toContain(MODEL);
    clearAiSettings();
    expect(store.read()).toBeNull();
    expect(readAiSettings()).toBeNull();
    expect(isAiConfigured()).toBe(false);
  });

  it("namespaces local storage so it cannot collide with journal data", () => {
    expect(AI_SETTINGS_STORAGE_KEY).toBe("gold-journal.ai.google:v1");
    expect(AI_SETTINGS_STORAGE_KEY).toContain("gold-journal.");
  });

  it("notifies subscribers so the UI reacts to save and remove", () => {
    const listeners = new Set<() => void>();
    vi.stubGlobal("window", {
      addEventListener: (name: string, listener: () => void) => { if (name !== "storage") listeners.add(listener); },
      removeEventListener: (_name: string, listener: () => void) => { listeners.delete(listener); },
      dispatchEvent: () => { listeners.forEach(listener => listener()); return true; },
    });
    const listener = vi.fn();
    const unsubscribe = subscribeAiSettings(listener);
    saveAiSettings({ apiKey: KEY, model: MODEL });
    clearAiSettings();
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rejects an obviously invalid key instead of storing it", () => {
    expect(() => saveAiSettings({ apiKey: "short", model: MODEL })).toThrow(/valid Google AI Studio API key/);
    expect(isAiConfigured()).toBe(false);
  });

  it("discards a legacy OpenRouter key so it is never mis-used against Gemini", () => {
    vi.stubGlobal("window", {
      localStorage: (() => {
        const map = new Map<string, string>([["gold-journal.ai.openrouter:v1", JSON.stringify({ apiKey: "sk-or-v1-legacy", model: "openai/gpt-4o-mini", updatedAt: 1 })]]);
        return {
          getItem: (key: string) => map.get(key) ?? null,
          setItem: (key: string, value: string) => void map.set(key, value),
          removeItem: (key: string) => void map.delete(key),
        };
      })(),
    });
    expect(readAiSettings()).toBeNull();
    expect(isAiConfigured()).toBe(false);
    expect(window.localStorage.getItem("gold-journal.ai.openrouter:v1")).toBeNull();
  });
});

describe("Gemini model configuration is the single source of truth", () => {
  it("lists only text generation models this key can call", async () => {
    stubGemini(() => providerResponse(signedReport()));
    saveAiSettings({ apiKey: KEY, model: MODEL });
    await expect(getAvailableGeminiModels()).resolves.toMatchObject([
      { id: "gemini-3.8-flash" },
      { id: "gemini-3.5-flash" },
    ]);
  });

  it("caches the model listing per key so analysis costs one round trip", async () => {
    const { calls } = stubGemini(() => providerResponse(signedReport()));
    saveAiSettings({ apiKey: KEY, model: MODEL });
    await getAvailableGeminiModels();
    await getAvailableGeminiModels();
    expect(calls.filter(([url]) => url.includes("/models?"))).toHaveLength(1);
  });

  it("refuses to list models without a configured key and makes no network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getAvailableGeminiModels()).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves the configured model when it is still offered", async () => {
    stubGemini(() => providerResponse(signedReport()));
    const resolution = await resolveCompatibleModel({ apiKey: KEY, preferred: "models/gemini-3.8-flash" });
    expect(resolution).toMatchObject({ requested: "gemini-3.8-flash", model: "gemini-3.8-flash", repairedFrom: null });
    expect(resolution.available).toEqual(["gemini-3.8-flash", "gemini-3.5-flash"]);
  });

  it("repairs a retired model to an available one instead of sending it to generateContent", async () => {
    stubGemini(() => providerResponse(signedReport()));
    const resolution = await resolveCompatibleModel({ apiKey: KEY, preferred: "gemini-2.0-flash" });
    expect(resolution.repairedFrom).toBe("gemini-2.0-flash");
    expect(resolution.model).toBe("gemini-3.8-flash");
  });

  it("reports a model error when the key can reach no usable generation model", async () => {
    stubGemini(() => providerResponse(signedReport()), () => modelsResponse([{ name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }]));
    await expect(resolveCompatibleModel({ apiKey: KEY, preferred: MODEL })).rejects.toMatchObject({ code: "model_not_found" });
  });
});

describe("Gemini connection status", () => {
  it("reports a valid key, the compatible model count, and the selected model state", async () => {
    stubGemini(() => providerResponse(signedReport()));
    const status = await checkGeminiConnection({ apiKey: KEY, model: MODEL });
    expect(status).toMatchObject({ provider: "gemini", ok: true, modelCount: 2, selectedModel: MODEL, selectedModelAvailable: true });
    expect(status.message).toMatch(/API key valid/);
    expect(status.maskedKey).not.toBe(KEY);
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("flags a selected model that the key can no longer call", async () => {
    stubGemini(() => providerResponse(signedReport()));
    const status = await checkGeminiConnection({ apiKey: KEY, model: "gemini-2.0-flash" });
    expect(status).toMatchObject({ ok: false, selectedModelAvailable: false, resolvedModel: "gemini-3.8-flash", errorCode: "model_not_found" });
    expect(status.message).toMatch(/no longer offered/);
  });

  it("reports an invalid key without a network retry loop", async () => {
    const { calls } = stubGemini(() => providerResponse(signedReport()), () => new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 400, headers: { "Content-Type": "application/json" } }));
    const status = await checkGeminiConnection({ apiKey: KEY, model: MODEL });
    expect(status).toMatchObject({ ok: false, errorCode: "invalid_key" });
    expect(calls).toHaveLength(1);
  });

  it("reports an exhausted quota distinctly from a rate limit", async () => {
    stubGemini(() => providerResponse(signedReport()), () => new Response(JSON.stringify({ error: { message: "You exceeded your current quota, check your plan and billing details." } }), { status: 429, headers: { "Content-Type": "application/json" } }));
    await expect(checkGeminiConnection({ apiKey: KEY, model: MODEL })).resolves.toMatchObject({ ok: false, errorCode: "quota_exceeded" });
  });

  it("reports a network failure instead of crashing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(checkGeminiConnection({ apiKey: KEY, model: MODEL })).resolves.toMatchObject({ ok: false, errorCode: "network_error" });
  });

  it("reports not-configured when no key is supplied", async () => {
    await expect(checkGeminiConnection()).resolves.toMatchObject({ ok: false, errorCode: "not_configured" });
  });
});

describe("browser analysis", () => {
  beforeEach(() => {
    saveAiSettings({ apiKey: KEY, model: MODEL });
  });

  it("returns a not-configured outcome without any network call", async () => {
    clearAiSettings();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(false);
    expect(outcome.errorCode).toBe("not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies the model, then sends only the selected model and compact evidence", async () => {
    const { postCalls, calls } = stubGemini(() => providerResponse(signedReport()));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(true);
    // One GET to verify the model list, one POST to generate.
    expect(calls).toHaveLength(2);
    expect(postCalls()).toHaveLength(1);
    const [url, init] = postCalls()[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    const body = JSON.parse(String(init!.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.contents[0].parts[0].text).not.toContain(KEY);
    expect(body.contents[0].parts[0].text).not.toContain("PRIVATE_NOTE_SHOULD_NOT_REACH_AI");
    expect(body.contents[0].parts[0].text).not.toContain("screenshotKey");
    // No Gold Journal endpoint is ever contacted for inference.
    expect(url).not.toContain("/api/trpc");
    expect(url).not.toContain("/api/ai-job-dispatch");
  });

  it("repairs a retired saved model, persists it, and reports the swap", async () => {
    saveAiSettings({ apiKey: KEY, model: "gemini-2.0-flash" });
    const { postCalls } = stubGemini(() => providerResponse(signedReport()));
    const outcome = await analyzeJournal({ analysis, model: "gemini-2.0-flash" });
    expect(outcome.available).toBe(true);
    expect(outcome.modelRepairedFrom).toBe("gemini-2.0-flash");
    expect(outcome.model).toBe("gemini-3.8-flash");
    expect(readAiSettings()?.model).toBe("gemini-3.8-flash");
    expect(postCalls()[0][0]).toContain("models/gemini-3.8-flash:generateContent");
  });

  it("stops with a model error when the key has no usable generation model", async () => {
    const { postCalls } = stubGemini(() => providerResponse(signedReport()), () => modelsResponse([{ name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }]));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(false);
    expect(outcome.errorCode).toBe("model_not_found");
    expect(outcome.message).toMatch(/AI settings/);
    expect(postCalls()).toHaveLength(0);
  });

  it("still analyzes with the saved model when the model list is temporarily unreachable", async () => {
    const { postCalls } = stubGemini(() => providerResponse(signedReport()), () => { throw new TypeError("Failed to fetch"); });
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(true);
    expect(outcome.warning).toMatch(/could not be verified/);
    expect(postCalls()[0][0]).toContain("models/gemini-3.8-flash:generateContent");
  });

  it("caches by service version, model, and dataset fingerprint so re-clicking does not re-spend tokens", async () => {
    const { postCalls } = stubGemini(() => providerResponse(signedReport()));
    const first = await analyzeJournal({ analysis });
    const second = await analyzeJournal({ analysis });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(postCalls()).toHaveLength(1);
    // A different dataset must never reuse the cached report.
    const other = await analyzeJournal({ analysis: { ...analysis, version: `${analysis.version}-b` } });
    expect(other.available).toBe(true);
    expect(postCalls()).toHaveLength(2);
  });

  it("never serves a cached failure as a success", async () => {
    stubGemini(() => providerResponse({}, 401));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(false);
    expect(outcome.errorCode).toBe("invalid_key");
    expect(outcome.cached).toBe(false);
  });

  it("honours an explicit model selection that the key can call", async () => {
    const { postCalls } = stubGemini(() => providerResponse(signedReport()));
    await analyzeJournal({ analysis, model: "gemini-3.5-flash" });
    expect(postCalls()[0][0]).toContain("models/gemini-3.5-flash:");
  });

  it("rejects malformed and ungrounded reports without breaking deterministic analysis", async () => {
    stubGemini(() => providerResponse("not json"));
    const malformed = await analyzeJournal({ analysis });
    expect(malformed.available).toBe(false);
    expect(malformed.errorCode).toBe("malformed_response");

    clearAiCache();
    stubGemini(() => providerResponse(signedReport({ executiveSummary: "999 trades prove this edge." })));
    const ungrounded = await analyzeJournal({ analysis });
    expect(ungrounded.available).toBe(false);
    expect(ungrounded.errorCode).toBe("ungrounded_response");
  });

  it("reports a schema error when the structured response fails local validation", async () => {
    stubGemini(() => providerResponse({ executiveSummary: "only a summary" }));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(false);
    expect(outcome.errorCode).toBe("schema_error");
    expect(outcome.report).toBeNull();
  });

  it("surfaces an invalid key distinctly from a provider outage", async () => {
    stubGemini(() => providerResponse({}, 401));
    expect((await analyzeJournal({ analysis })).errorCode).toBe("invalid_key");
    clearAiCache();
    stubGemini(() => providerResponse({}, 500));
    expect((await analyzeJournal({ analysis })).errorCode).toBe("provider_error");
    clearAiCache();
    stubGemini(() => providerResponse({}, 429));
    expect((await analyzeJournal({ analysis })).errorCode).toBe("rate_limited");
  });

  it("surfaces a model rejected at generation time as a model error", async () => {
    stubGemini(() => new Response(JSON.stringify({ error: { message: "models/gemini-1.0-ultra is not found for API version v1beta" } }), { status: 404, headers: { "Content-Type": "application/json" } }));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.errorCode).toBe("model_not_found");
  });

  it("reports a timeout with a retryable message", async () => {
    const hanging = vi.fn((_url: string, init: RequestInit) => {
      if ((init.method ?? "GET").toUpperCase() === "GET") return Promise.resolve(modelsResponse());
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    vi.stubGlobal("fetch", hanging);
    const outcome = await analyzeJournal({ analysis, timeoutMs: 5 });
    expect(outcome.errorCode).toBe("timeout");
    expect(outcome.message).toMatch(/timed out/i);
    // The service clamps to a 5s floor, so this test needs headroom over it.
  }, 15_000);

  it("reports an offline network failure without claiming the journal is affected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.errorCode).toBe("network_error");
  });
});

describe("browser key verification", () => {
  it("tests the supplied key directly against the Gemini model listing", async () => {
    const { calls } = stubGemini(() => providerResponse({}));
    saveAiSettings({ apiKey: KEY, model: MODEL });
    await expect(testAiConnection()).resolves.toBeDefined();
    expect(calls[0][0]).toContain("https://generativelanguage.googleapis.com/v1beta/models");
  });

  it("refuses to test without a configured key", async () => {
    await expect(testAiConnection()).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("browser risk coach", () => {
  it("requires local configuration", async () => {
    const outcome = await coachRisk({ calculation });
    expect(outcome.available).toBe(false);
    expect(outcome.errorCode).toBe("not_configured");
  });

  it("accepts a cautious review and sends no credential", async () => {
    saveAiSettings({ apiKey: KEY, model: MODEL });
    const { postCalls } = stubGemini(() => providerResponse({ readiness: "CAUTION", summary: "Verify broker margin.", cautions: ["Margin is unconfirmed."], verificationSteps: ["Check free margin in MT5."] }));
    const outcome = await coachRisk({ calculation });
    expect(outcome.available).toBe(true);
    expect(outcome.coach?.readiness).toBe("CAUTION");
    expect(JSON.stringify(JSON.parse(String(postCalls()[0][1]!.body)))).not.toContain(KEY);
  });

  it("repairs a retired model for the coach too, so one configuration serves every surface", async () => {
    saveAiSettings({ apiKey: KEY, model: "gemini-2.0-flash" });
    const { postCalls } = stubGemini(() => providerResponse({ readiness: "VERIFY", summary: "Verify broker margin.", cautions: [], verificationSteps: ["Confirm margin."] }));
    const outcome = await coachRisk({ calculation, model: "gemini-2.0-flash" });
    expect(outcome.model).toBe("gemini-3.8-flash");
    expect(outcome.modelRepairedFrom).toBe("gemini-2.0-flash");
    expect(postCalls()[0][0]).toContain("models/gemini-3.8-flash:");
  });

  it("rejects a review that tries to give a trade direction", async () => {
    saveAiSettings({ apiKey: KEY, model: MODEL });
    stubGemini(() => providerResponse({ readiness: "VERIFY", summary: "Buy now with a tighter stop.", cautions: [], verificationSteps: ["Confirm margin."] }));
    const outcome = await coachRisk({ calculation });
    expect(outcome.available).toBe(false);
    expect(outcome.errorCode).toBe("ungrounded_response");
  });
});

describe("shared AI core", () => {
  it("produces deterministic 16-character evidence hashes without node crypto", () => {
    expect(stableHash16("gold-journal")).toBe(stableHash16("gold-journal"));
    expect(stableHash16("gold-journal")).toMatch(/^[a-f0-9]{16}$/);
    expect(stableHash16("gold-journal")).not.toBe(stableHash16("gold-journal-2"));
    expect(analysisDataFingerprint(analysis)).toMatch(/^[a-f0-9]{16}$/);
  });

  it("normalizes model ids so a request path can never contain a double `models/` prefix", () => {
    expect(normalizeGeminiModelId("models/gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(normalizeGeminiModelId("models/models/gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(normalizeGeminiModelId("/models/gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(normalizeGeminiModelId("  gemini-3.8-flash  ")).toBe("gemini-3.8-flash");
  });

  it("rejects models that answer generateContent but cannot write a report", () => {
    expect(isUsableGeminiModelId("gemini-3.8-flash")).toBe(true);
    expect(isUsableGeminiModelId("gemini-3.1-pro-preview")).toBe(true);
    expect(isUsableGeminiModelId("gemini-3.1-flash-image")).toBe(false);
    expect(isUsableGeminiModelId("gemini-2.5-flash-preview-tts")).toBe(false);
    expect(isUsableGeminiModelId("gemini-3.8-live")).toBe(false);
    expect(isUsableGeminiModelId("text-embedding-004")).toBe(false);
    expect(isUsableGeminiModelId("")).toBe(false);
  });

  it("ranks preferred models first and keeps a stable, preview-last order for the rest", () => {
    expect(rankGeminiModels(["gemini-2.5-pro", "gemini-3.8-flash", "gemini-3.5-flash"])).toEqual([
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-2.5-pro",
    ]);
    expect(rankGeminiModels(["gemini-4.2-flash", "gemini-4.5-flash-preview"])).toEqual([
      "gemini-4.2-flash",
      "gemini-4.5-flash-preview",
    ]);
  });

  it("picks the caller's model when available and the best model otherwise", () => {
    expect(pickPreferredGeminiModel(["gemini-3.8-flash", "gemini-3.5-flash"], "gemini-3.5-flash")).toBe("gemini-3.5-flash");
    expect(pickPreferredGeminiModel(["gemini-3.8-flash", "gemini-3.5-flash"], "gemini-1.0-ultra")).toBe("gemini-3.8-flash");
    expect(pickPreferredGeminiModel([], "gemini-3.8-flash")).toBeNull();
  });

  it("bumps a version when the request contract changes so cached reports cannot go stale", () => {
    expect(AI_SERVICE_VERSION).toMatch(/^\d{4}-\d{2}-gemini/);
  });
});

describe("AI failure states map onto distinct UI states", () => {
  it("keeps a Gemini outage separate from a report that failed local validation", () => {
    expect(uiStateForErrorCode("model_not_found")).toBe("model_not_found");
    expect(uiStateForErrorCode("model_unsupported")).toBe("model_unsupported");
    expect(uiStateForErrorCode("quota_exceeded")).toBe("quota_exceeded");
    expect(uiStateForErrorCode("provider_error")).toBe("provider_error");
    expect(uiStateForErrorCode("ungrounded_response")).toBe("schema_error");
    expect(uiStateForErrorCode("malformed_response")).toBe("schema_error");
    expect(uiStateForErrorCode(null)).toBe("provider_error");
    expect(uiStateForErrorCode(undefined)).toBe("provider_error");
  });

  it("marks only model failures as model failures", () => {
    expect(isModelError("model_not_found")).toBe(true);
    expect(isModelError("model_unsupported")).toBe(true);
    expect(isModelError("provider_error")).toBe(false);
    expect(isModelError(null)).toBe(false);
  });
});
