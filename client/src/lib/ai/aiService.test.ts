import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnalysis } from "@shared/analysisEngine";
import { AI_SERVICE_VERSION, analysisDataFingerprint, isUsableGroqModelId, normalizeGroqModelId, pickPreferredGroqModel, rankGroqModels, stableHash16 } from "@shared/aiCore";
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
import { analyzeJournal, checkGroqConnection, clearAiCache, getAvailableGroqModels, isAiConfigured, resolveCompatibleModel, testAiConnection } from "./aiService";
import { GROQ_CHAT_COMPLETIONS_URL, GROQ_MODELS_URL } from "./groqClient";
import { isModelError, uiStateForErrorCode } from "./aiTypes";

const KEY = "gsk_test_only_key_0123456789abcdef";
const MODEL = "openai/gpt-oss-120b";

const MODELS = [
  { id: "openai/gpt-oss-120b", owned_by: "openai", context_window: 131_072 },
  { id: "llama-3.3-70b-versatile", owned_by: "groq", context_window: 131_072 },
  { id: "whisper-large-v3", owned_by: "openai" },
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


function providerResponse(content: unknown, status = 200) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }] }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function modelsResponse(data: unknown[] = MODELS, status = 200) {
  return new Response(JSON.stringify({ data }), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Groq answers a GET for the model listing and a POST for chat completions. The
 * real client makes both, so the stub routes both and the `postCalls` array
 * holds only the inference attempts.
 */
function stubGroq(post: (callIndex: number, url: string) => Response | Promise<Response>, get: () => Response | Promise<Response> = () => modelsResponse()) {
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

  it("persists under the Groq-namespaced key and clears the record completely on removal", () => {
    const store = memoryAiSettingsPersistence();
    setAiSettingsPersistence(store);
    saveAiSettings({ apiKey: KEY, model: MODEL });
    expect(store.read()).toContain(MODEL);
    clearAiSettings();
    expect(store.read()).toBeNull();
    expect(readAiSettings()).toBeNull();
    expect(isAiConfigured()).toBe(false);
  });

  it("namespaces local storage under Groq so it cannot collide with journal data or the retired providers", () => {
    expect(AI_SETTINGS_STORAGE_KEY).toBe("gold-journal.ai.groq:v1");
    expect(AI_SETTINGS_STORAGE_KEY).toContain("gold-journal.");
    expect(AI_SETTINGS_STORAGE_KEY).not.toContain("google");
    expect(AI_SETTINGS_STORAGE_KEY).not.toContain("openrouter");
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
    expect(() => saveAiSettings({ apiKey: "short", model: MODEL })).toThrow(/valid Groq API key/);
    expect(isAiConfigured()).toBe(false);
  });

  it("discards a legacy Gemini key so it is never mis-used against Groq, leaving AI unconfigured", () => {
    const stored = new Map<string, string>([["gold-journal.ai.google:v1", JSON.stringify({ apiKey: "AIzaSyLegacyGeminiKey0123456789", model: "gemini-3.8-flash", updatedAt: 1 })]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
      },
    });
    expect(readAiSettings()).toBeNull();
    expect(isAiConfigured()).toBe(false);
    expect(window.localStorage.getItem("gold-journal.ai.google:v1")).toBeNull();
    // A Gemini key can never be silently reinterpreted as a Groq key.
    expect(readAiSettings()?.apiKey ?? null).toBeNull();
  });

  it("discards a legacy OpenRouter key for the same reason", () => {
    const stored = new Map<string, string>([["gold-journal.ai.openrouter:v1", JSON.stringify({ apiKey: "sk-or-v1-legacy", model: "openai/gpt-4o-mini", updatedAt: 1 })]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
      },
    });
    expect(readAiSettings()).toBeNull();
    expect(window.localStorage.getItem("gold-journal.ai.openrouter:v1")).toBeNull();
  });
});

describe("Groq model configuration is the single source of truth", () => {
  it("lists only chat models this key can call", async () => {
    stubGroq(() => providerResponse(signedReport()));
    saveAiSettings({ apiKey: KEY, model: MODEL });
    await expect(getAvailableGroqModels()).resolves.toMatchObject([
      { id: "openai/gpt-oss-120b" },
      { id: "llama-3.3-70b-versatile" },
    ]);
  });

  it("caches the model listing per key so analysis costs one extra round trip", async () => {
    const { calls } = stubGroq(() => providerResponse(signedReport()));
    saveAiSettings({ apiKey: KEY, model: MODEL });
    await getAvailableGroqModels();
    await getAvailableGroqModels();
    expect(calls.filter(([url]) => url === GROQ_MODELS_URL)).toHaveLength(1);
  });

  it("refuses to list models without a configured key and makes no network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getAvailableGroqModels()).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves the configured model when it is still offered", async () => {
    stubGroq(() => providerResponse(signedReport()));
    const resolution = await resolveCompatibleModel({ apiKey: KEY, preferred: "openai/gpt-oss-120b" });
    expect(resolution).toMatchObject({ provider: "groq", requested: "openai/gpt-oss-120b", model: "openai/gpt-oss-120b", repairedFrom: null });
    expect(resolution.available).toEqual(["openai/gpt-oss-120b", "llama-3.3-70b-versatile"]);
  });

  it("repairs a retired model to an available one instead of sending it to Groq", async () => {
    stubGroq(() => providerResponse(signedReport()));
    const resolution = await resolveCompatibleModel({ apiKey: KEY, preferred: "llama-2-70b-chat" });
    expect(resolution.repairedFrom).toBe("llama-2-70b-chat");
    expect(resolution.model).toBe("openai/gpt-oss-120b");
  });

  it("reports a model error when the key can reach no usable chat model", async () => {
    stubGroq(() => providerResponse(signedReport()), () => modelsResponse([{ id: "whisper-large-v3" }]));
    await expect(resolveCompatibleModel({ apiKey: KEY, preferred: MODEL })).rejects.toMatchObject({ code: "model_not_found" });
  });
});

describe("Groq connection status", () => {
  it("performs a real request and reports a valid key, the compatible model count, and the selected model state", async () => {
    stubGroq(() => providerResponse(signedReport()));
    const status = await checkGroqConnection({ apiKey: KEY, model: MODEL });
    expect(status).toMatchObject({ provider: "groq", ok: true, modelCount: 2, selectedModel: MODEL, selectedModelAvailable: true });
    expect(status.message).toMatch(/Groq connected successfully/);
    expect(status.maskedKey).not.toBe(KEY);
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("flags a selected model that the key can no longer call", async () => {
    stubGroq(() => providerResponse(signedReport()));
    const status = await checkGroqConnection({ apiKey: KEY, model: "llama-2-70b-chat" });
    expect(status).toMatchObject({ ok: false, selectedModelAvailable: false, resolvedModel: "openai/gpt-oss-120b", errorCode: "model_not_found" });
    expect(status.message).toMatch(/no longer offered/);
  });

  it("reports an invalid key without a network retry loop", async () => {
    const { calls } = stubGroq(() => providerResponse(signedReport()), () => new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401, headers: { "Content-Type": "application/json" } }));
    const status = await checkGroqConnection({ apiKey: KEY, model: MODEL });
    expect(status).toMatchObject({ ok: false, errorCode: "invalid_key" });
    expect(calls).toHaveLength(1);
  });

  it("reports an exhausted quota distinctly from a rate limit", async () => {
    stubGroq(() => providerResponse(signedReport()), () => new Response(JSON.stringify({ error: { message: "You exceeded your current quota, check your plan and billing details." } }), { status: 429, headers: { "Content-Type": "application/json" } }));
    await expect(checkGroqConnection({ apiKey: KEY, model: MODEL })).resolves.toMatchObject({ ok: false, errorCode: "quota_exceeded" });
  });

  it("reports a network failure instead of crashing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(checkGroqConnection({ apiKey: KEY, model: MODEL })).resolves.toMatchObject({ ok: false, errorCode: "network_error" });
  });

  it("reports not-configured when no key is supplied", async () => {
    await expect(checkGroqConnection()).resolves.toMatchObject({ ok: false, errorCode: "not_configured" });
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

  it("verifies the model, then sends only the selected model and compact evidence to Groq", async () => {
    const { postCalls, calls } = stubGroq(() => providerResponse(signedReport()));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(true);
    // One GET to verify the model list, one POST to generate.
    expect(calls).toHaveLength(2);
    expect(postCalls()).toHaveLength(1);
    const [url, init] = postCalls()[0];
    expect(url).toBe(GROQ_CHAT_COMPLETIONS_URL);
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[1].content).not.toContain(KEY);
    expect(body.messages[1].content).not.toContain("PRIVATE_NOTE_SHOULD_NOT_REACH_AI");
    expect(body.messages[1].content).not.toContain("screenshotKey");
    // The key travels in the Authorization header only, never in the URL.
    expect(url).not.toContain(KEY);
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    // No Gold Journal endpoint is ever contacted for inference.
    expect(url).not.toContain("/api/trpc");
    expect(url).not.toContain("/api/ai-job-dispatch");
  });

  it("repairs a retired saved model, persists it, and reports the swap", async () => {
    saveAiSettings({ apiKey: KEY, model: "llama-2-70b-chat" });
    const { postCalls } = stubGroq(() => providerResponse(signedReport()));
    const outcome = await analyzeJournal({ analysis, model: "llama-2-70b-chat" });
    expect(outcome.available).toBe(true);
    expect(outcome.modelRepairedFrom).toBe("llama-2-70b-chat");
    expect(outcome.model).toBe("openai/gpt-oss-120b");
    expect(readAiSettings()?.model).toBe("openai/gpt-oss-120b");
    expect(JSON.parse(String(postCalls()[0][1]!.body)).model).toBe("openai/gpt-oss-120b");
  });

  it("stops with a model error when the key has no usable chat model", async () => {
    const { postCalls } = stubGroq(() => providerResponse(signedReport()), () => modelsResponse([{ id: "whisper-large-v3" }]));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(false);
    expect(outcome.errorCode).toBe("model_not_found");
    expect(outcome.message).toMatch(/AI settings/);
    expect(postCalls()).toHaveLength(0);
  });

  it("still analyzes with the saved model when the model list is temporarily unreachable", async () => {
    const { postCalls } = stubGroq(() => providerResponse(signedReport()), () => { throw new TypeError("Failed to fetch"); });
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(true);
    expect(outcome.warning).toMatch(/could not be verified/);
    expect(JSON.parse(String(postCalls()[0][1]!.body)).model).toBe("openai/gpt-oss-120b");
  });

  it("caches by service version, provider, model, and dataset fingerprint so re-clicking does not re-spend tokens", async () => {
    const { postCalls } = stubGroq(() => providerResponse(signedReport()));
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
    stubGroq(() => providerResponse({}, 401));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(false);
    expect(outcome.errorCode).toBe("invalid_key");
    expect(outcome.cached).toBe(false);
  });

  it("honours an explicit model selection that the key can call", async () => {
    const { postCalls } = stubGroq(() => providerResponse(signedReport()));
    await analyzeJournal({ analysis, model: "llama-3.3-70b-versatile" });
    expect(JSON.parse(String(postCalls()[0][1]!.body)).model).toBe("llama-3.3-70b-versatile");
  });

  it("rejects malformed and ungrounded reports without breaking deterministic analysis", async () => {
    stubGroq(() => providerResponse("not json"));
    const malformed = await analyzeJournal({ analysis });
    expect(malformed.available).toBe(false);
    expect(malformed.errorCode).toBe("malformed_response");

    clearAiCache();
    stubGroq(() => providerResponse(signedReport({ executiveSummary: "999 trades prove this edge." })));
    const ungrounded = await analyzeJournal({ analysis });
    expect(ungrounded.available).toBe(false);
    expect(ungrounded.errorCode).toBe("ungrounded_response");
  });

  it("reports a schema error when the structured response fails local validation", async () => {
    stubGroq(() => providerResponse({ executiveSummary: "only a summary" }));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(false);
    expect(outcome.errorCode).toBe("schema_error");
    expect(outcome.report).toBeNull();
  });

  it("surfaces an invalid key distinctly from a provider outage", async () => {
    stubGroq(() => providerResponse({}, 401));
    expect((await analyzeJournal({ analysis })).errorCode).toBe("invalid_key");
    clearAiCache();
    stubGroq(() => providerResponse({}, 429));
    expect((await analyzeJournal({ analysis })).errorCode).toBe("rate_limited");
  });

  it("retries a temporary 5xx exactly once, then succeeds", async () => {
    const { postCalls } = stubGroq(callIndex => (callIndex === 0 ? providerResponse({}, 503) : providerResponse(signedReport())));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(true);
    expect(postCalls()).toHaveLength(2);
  });

  it("never retries more than once, and reports the provider error", async () => {
    const { postCalls } = stubGroq(() => providerResponse({}, 503));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(false);
    expect(outcome.errorCode).toBe("provider_error");
    expect(postCalls()).toHaveLength(2);
  });

  it("surfaces a model rejected at generation time as a model error with no retry loop", async () => {
    const { postCalls } = stubGroq(() => new Response(JSON.stringify({ error: { message: "The model `openai/gpt-oss-999` does not exist." } }), { status: 404, headers: { "Content-Type": "application/json" } }));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.errorCode).toBe("model_not_found");
    expect(postCalls()).toHaveLength(1);
  });

  it("reports a timeout with a retryable message", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      if ((init.method ?? "GET").toUpperCase() === "GET") return Promise.resolve(modelsResponse());
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }));
    const outcome = await analyzeJournal({ analysis, timeoutMs: 5 });
    expect(outcome.errorCode).toBe("timeout");
    expect(outcome.message).toMatch(/timed out/i);
    // Two attempts: the service clamps to a 5s floor and retries a timeout once,
    // so this test needs headroom over the combined 10s+.
  }, 30_000);

  it("reports an offline network failure without claiming the journal is affected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.errorCode).toBe("network_error");
  });
});

describe("browser key verification", () => {
  it("tests the supplied key directly against the Groq model listing", async () => {
    const { calls } = stubGroq(() => providerResponse({}));
    saveAiSettings({ apiKey: KEY, model: MODEL });
    await expect(testAiConnection()).resolves.toBeDefined();
    expect(calls[0][0]).toBe(GROQ_MODELS_URL);
    expect((calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
  });

  it("refuses to test without a configured key", async () => {
    await expect(testAiConnection()).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("shared AI core", () => {
  it("produces deterministic 16-character evidence hashes without node crypto", () => {
    expect(stableHash16("gold-journal")).toBe(stableHash16("gold-journal"));
    expect(stableHash16("gold-journal")).toMatch(/^[a-f0-9]{16}$/);
    expect(stableHash16("gold-journal")).not.toBe(stableHash16("gold-journal-2"));
    expect(analysisDataFingerprint(analysis)).toMatch(/^[a-f0-9]{16}$/);
  });

  it("normalizes a Groq model id without inventing a provider prefix", () => {
    expect(normalizeGroqModelId("openai/gpt-oss-120b")).toBe("openai/gpt-oss-120b");
    expect(normalizeGroqModelId("  llama-3.3-70b-versatile  ")).toBe("llama-3.3-70b-versatile");
    expect(normalizeGroqModelId("/openai/gpt-oss-20b")).toBe("openai/gpt-oss-20b");
  });

  it("rejects non-chat models that share Groq's /models endpoint", () => {
    expect(isUsableGroqModelId("openai/gpt-oss-120b")).toBe(true);
    expect(isUsableGroqModelId("llama-3.3-70b-versatile")).toBe(true);
    expect(isUsableGroqModelId("whisper-large-v3")).toBe(false);
    expect(isUsableGroqModelId("canopylabs/orpheus-v1-english")).toBe(false);
    expect(isUsableGroqModelId("meta-llama/llama-prompt-guard-2-22m")).toBe(false);
    expect(isUsableGroqModelId("openai/gpt-oss-safeguard-20b")).toBe(false);
    expect(isUsableGroqModelId("")).toBe(false);
  });

  it("ranks preferred models first and keeps a stable alphabetical order for the rest", () => {
    expect(rankGroqModels(["llama-3.3-70b-versatile", "openai/gpt-oss-20b", "openai/gpt-oss-120b"])).toEqual([
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "llama-3.3-70b-versatile",
    ]);
    expect(rankGroqModels(["z-other/model", "a-other/model"])).toEqual(["a-other/model", "z-other/model"]);
  });

  it("picks the caller's model when available and the best model otherwise", () => {
    expect(pickPreferredGroqModel(["openai/gpt-oss-120b", "llama-3.3-70b-versatile"], "llama-3.3-70b-versatile")).toBe("llama-3.3-70b-versatile");
    expect(pickPreferredGroqModel(["openai/gpt-oss-120b", "llama-3.3-70b-versatile"], "llama-2-70b-chat")).toBe("openai/gpt-oss-120b");
    expect(pickPreferredGroqModel([], "openai/gpt-oss-120b")).toBeNull();
  });

  it("bumps a version when the request contract changes so cached Gemini reports cannot go stale", () => {
    expect(AI_SERVICE_VERSION).toMatch(/^\d{4}-\d{2}-groq/);
    expect(AI_SERVICE_VERSION).not.toMatch(/gemini|openrouter|openai/i);
  });
});

describe("AI failure states map onto distinct UI states", () => {
  it("keeps a Groq outage separate from a report that failed local validation", () => {
    expect(uiStateForErrorCode("invalid_key")).toBe("invalid_key");
    expect(uiStateForErrorCode("unauthorized")).toBe("unauthorized");
    expect(uiStateForErrorCode("model_not_found")).toBe("model_not_found");
    expect(uiStateForErrorCode("model_unsupported")).toBe("model_unsupported");
    expect(uiStateForErrorCode("model_unavailable")).toBe("model_unavailable");
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
    expect(isModelError("model_unavailable")).toBe(true);
    expect(isModelError("provider_error")).toBe(false);
    expect(isModelError(null)).toBe(false);
  });
});
