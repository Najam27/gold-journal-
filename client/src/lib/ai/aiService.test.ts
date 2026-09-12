import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnalysis } from "@shared/analysisEngine";
import { analysisDataFingerprint, stableHash16 } from "@shared/aiCore";
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
import { analyzeJournal, clearAiCache, coachRisk, isAiConfigured, testAiConnection } from "./aiService";

const KEY = "sk-or-v1-test-only-key-0123456789";
const MODEL = "openai/gpt-4o-mini";

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
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), { status, headers: { "Content-Type": "application/json" } });
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
    expect(AI_SETTINGS_STORAGE_KEY).toBe("gold-journal.ai.openrouter:v1");
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
    expect(() => saveAiSettings({ apiKey: "short", model: MODEL })).toThrow(/valid OpenRouter API key/);
    expect(isAiConfigured()).toBe(false);
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

  it("sends only the selected model and compact evidence, never the key, notes, or a backend URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(signedReport()));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.available).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe(MODEL);
    expect(body.messages[1].content).not.toContain(KEY);
    expect(body.messages[1].content).not.toContain("PRIVATE_NOTE_SHOULD_NOT_REACH_AI");
    expect(body.messages[1].content).not.toContain("screenshotKey");
    // No Gold Journal endpoint is ever contacted for inference.
    expect(url).not.toContain("/api/trpc");
    expect(url).not.toContain("/api/ai-job-dispatch");
  });

  it("caches by model and dataset fingerprint so re-clicking does not re-spend tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(signedReport()));
    vi.stubGlobal("fetch", fetchMock);
    const first = await analyzeJournal({ analysis });
    const second = await analyzeJournal({ analysis });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honours an explicit model selection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(signedReport()));
    vi.stubGlobal("fetch", fetchMock);
    await analyzeJournal({ analysis, model: "anthropic/claude-3.5-sonnet" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).model).toBe("anthropic/claude-3.5-sonnet");
  });

  it("rejects malformed and ungrounded reports without breaking deterministic analysis", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(providerResponse("not json")));
    const malformed = await analyzeJournal({ analysis });
    expect(malformed.available).toBe(false);
    expect(malformed.errorCode).toBe("malformed_response");

    clearAiCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(providerResponse(signedReport({ executiveSummary: "999 trades prove this edge." }))));
    const ungrounded = await analyzeJournal({ analysis });
    expect(ungrounded.available).toBe(false);
    expect(ungrounded.errorCode).toBe("ungrounded_response");
  });

  it("surfaces an invalid key distinctly from a provider outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse({}, 401)));
    expect((await analyzeJournal({ analysis })).errorCode).toBe("invalid_key");
    clearAiCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse({}, 500)));
    expect((await analyzeJournal({ analysis })).errorCode).toBe("provider_error");
    clearAiCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse({}, 429)));
    expect((await analyzeJournal({ analysis })).errorCode).toBe("rate_limited");
  });

  it("reports a timeout with a retryable message", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const outcome = await analyzeJournal({ analysis, timeoutMs: 5 });
    expect(outcome.errorCode).toBe("timeout");
    expect(outcome.message).toMatch(/timed out/i);
  });

  it("reports an offline network failure without claiming the journal is affected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const outcome = await analyzeJournal({ analysis });
    expect(outcome.errorCode).toBe("network_error");
  });
});

describe("browser key verification", () => {
  it("tests the supplied key directly against OpenRouter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    saveAiSettings({ apiKey: KEY, model: MODEL });
    await expect(testAiConnection()).resolves.toBeDefined();
    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/key");
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
    const fetchMock = vi.fn().mockResolvedValue(providerResponse({ readiness: "CAUTION", summary: "Verify broker margin.", cautions: ["Margin is unconfirmed."], verificationSteps: ["Check free margin in MT5."] }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await coachRisk({ calculation });
    expect(outcome.available).toBe(true);
    expect(outcome.coach?.readiness).toBe("CAUTION");
    expect(JSON.stringify(JSON.parse(String(fetchMock.mock.calls[0][1].body)))).not.toContain(KEY);
  });

  it("rejects a review that tries to give a trade direction", async () => {
    saveAiSettings({ apiKey: KEY, model: MODEL });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse({ readiness: "VERIFY", summary: "Buy now with a tighter stop.", cautions: [], verificationSteps: ["Confirm margin."] })));
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
});
