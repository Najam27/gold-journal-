/**
 * The single browser AI service used by Analyze My Trade, the AI Mentor, AI
 * reports, and AI settings.
 *
 * The Risk Calculator is deliberately absent from this module: position sizing
 * is deterministic and broker-aware, and it must keep working when no key is
 * configured, Groq is unreachable, or the internet is offline.
 *
 * Provider: Groq — exclusively. There is exactly one provider path in the
 * active execution path. This module is the one source of truth for Groq
 * configuration and exposes:
 *
 *   getAiSettings()              — the stored credential + model
 *   verifyGroqApiKey()           — live key + model status
 *   getAvailableGroqModels()     — models this key can actually call
 *   resolveCompatibleModel()     — verifies/repairs the selected model
 *   requestGroqStructuredCompletion() — one validated Groq request
 *
 * Every call:
 *  1. reads the credential from local browser storage,
 *  2. verifies the selected model against Groq's live model list,
 *  3. calls Groq directly over HTTPS,
 *  4. validates the structured response against the shared schema and grounding
 *     rules, and
 *  5. returns a normalized outcome the UI can render.
 *
 * It never runs on a schedule, on page load, or on journal updates: only an
 * explicit user action starts a request.
 */
import {
  AI_PROVIDER_ID,
  AI_SERVICE_VERSION,
  ANALYSIS_RESPONSE_SCHEMA,
  ANALYSIS_SYSTEM_PROMPT,
  DEFAULT_AI_MODEL,
  MAX_AI_TIMEOUT_MS,
  aiReportSchema,
  analysisDataFingerprint,
  analysisUserPrompt,
  buildAnalysisPromptPayload,
  buildEvidenceManifest,
  hasOnlyGroundedNumbers,
  normalizeGroqModelId,
  pickPreferredGroqModel,
  resolveAiTimeoutMs,
  stableHash16,
  validateEvidenceReport,
  type AiReport,
} from "@shared/aiCore";
import type { AnalysisResult } from "@shared/analysisEngine";
import { maskApiKey, purgeLegacyProviderSettings, readAiSettings, readAiSettingsView, subscribeAiSettings, updateAiModel } from "./aiStorage";
import { AiError, type AiErrorCode, type AiSettings, type AiSettingsView, type AiUiState } from "./aiTypes";
import { listGroqModels, requestGroqStructuredCompletion as sendGroqCompletion, type GroqModelInfo, type KeyVerification } from "./groqClient";

const AI_CACHE_TTL_MS = 15 * 60_000;
const AI_CACHE_MAX = 64;
const MODEL_CACHE_TTL_MS = 10 * 60_000;
/**
 * Explicit, tiny retry budget. Only network failures, timeouts, and temporary
 * Groq 5xx responses are retried, and only once: an invalid key, an unauthorized
 * key, a missing model, or a rejected request is surfaced immediately and never
 * looped.
 */
const TRANSIENT_RETRY_LIMIT = 1;
const TRANSIENT_RETRY_DELAY_MS = 600;
const cache = new Map<string, { expiresAt: number; outcome: AiAnalysisOutcome }>();
let modelCache: { key: string; expiresAt: number; models: GroqModelInfo[] } | null = null;

/** Legacy-compatible outcome shape so existing report renderers stay valid. */
export type AiAnalysisOutcome = {
  available: boolean;
  cached: boolean;
  model: string | null;
  report: AiReport | null;
  message?: string;
  errorCode?: AiErrorCode;
  /** Set when the saved model was retired and a verified model replaced it. */
  modelRepairedFrom?: string | null;
  /** Models the key could call at the time of the call. Never contains a key. */
  availableModels?: string[];
  /** Non-fatal note, e.g. the model list could not be verified. */
  warning?: string;
  /** True when Groq rejected the strict schema and JSON-object mode was used. */
  schemaFallback?: boolean;
};

/* ------------------------------------------------------------------ *
 * Central configuration
 * ------------------------------------------------------------------ */

/** The stored Groq credential. This is the only reader of the raw key. */
export function getAiSettings(): AiSettings | null {
  return readAiSettings();
}

export function aiSettingsStatus(): AiSettingsView {
  return readAiSettingsView();
}

export function isAiConfigured(): boolean {
  return readAiSettings() !== null;
}

/** Drops every cached result and the cached model list. */
export function clearAiCache() {
  cache.clear();
  modelCache = null;
}

/**
 * Settings can change in another tab or through the settings panel. Any change
 * invalidates the model list and every cached report so a stale model or a
 * failed result can never be replayed as current.
 */
subscribeAiSettings(clearAiCache);

/**
 * Runs once when the AI layer loads (i.e. on app start, since every AI surface
 * imports this module): any credential stored under a retired provider's
 * namespace is deleted so it can never be read as a Groq key.
 */
purgeLegacyProviderSettings();

function fingerprintKey(apiKey: string) {
  // The map key is a digest, so the raw credential never sits in a cache key.
  return stableHash16(apiKey);
}

/**
 * Models this key can actually call. Results are cached for ten minutes per key
 * digest to keep analysis to a single extra network round trip.
 */
export async function getAvailableGroqModels(input: { apiKey?: string; force?: boolean; signal?: AbortSignal } = {}): Promise<GroqModelInfo[]> {
  const apiKey = input.apiKey?.trim() || getAiSettings()?.apiKey;
  if (!apiKey) throw new AiError("not_configured", "Add your Groq API key first.");
  const key = fingerprintKey(apiKey);
  if (!input.force && modelCache && modelCache.key === key && modelCache.expiresAt > Date.now()) return modelCache.models;
  const models = await listGroqModels(apiKey, { signal: input.signal });
  modelCache = { key, expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models };
  return models;
}

export type GroqConnectionStatus = {
  provider: "groq";
  ok: boolean;
  /** Always masked; the raw key is never returned or logged. */
  maskedKey: string | null;
  modelCount: number;
  models: string[];
  selectedModel: string;
  selectedModelAvailable: boolean;
  resolvedModel: string | null;
  errorCode: AiErrorCode | null;
  message: string;
};

/**
 * Verifies the key against Groq's live model listing, then confirms the selected
 * model exists. Returns a status object; use `verifyGroqApiKey` when a thrown
 * error is more convenient.
 */
export async function checkGroqConnection(input: { apiKey?: string; model?: string | null; force?: boolean; signal?: AbortSignal } = {}): Promise<GroqConnectionStatus> {
  const settings = getAiSettings();
  const apiKey = input.apiKey?.trim() || settings?.apiKey || "";
  const requested = normalizeGroqModelId(input.model ?? settings?.model ?? DEFAULT_AI_MODEL);
  const base = { provider: "groq" as const, maskedKey: apiKey ? maskApiKey(apiKey) : null, selectedModel: requested };
  if (!apiKey) {
    return { ...base, ok: false, modelCount: 0, models: [], selectedModelAvailable: false, resolvedModel: null, errorCode: "not_configured", message: "Add your Groq API key first." };
  }
  try {
    const models = await getAvailableGroqModels({ apiKey, force: input.force, signal: input.signal });
    const ids = models.map(model => model.id);
    const resolved = pickPreferredGroqModel(ids, requested);
    if (!resolved) {
      return { ...base, ok: false, modelCount: 0, models: [], selectedModelAvailable: false, resolvedModel: null, errorCode: "model_not_found", message: "This Groq API key cannot access any chat model. Check the key's project and model permissions in the Groq console." };
    }
    const selectedModelAvailable = ids.includes(requested);
    return {
      ...base,
      ok: selectedModelAvailable,
      modelCount: ids.length,
      models: ids,
      selectedModelAvailable,
      resolvedModel: resolved,
      errorCode: selectedModelAvailable ? null : "model_not_found",
      message: selectedModelAvailable
        ? `Groq connected successfully. ${ids.length} compatible model${ids.length === 1 ? "" : "s"} available.`
        : `Groq accepted this API key, but "${requested}" is no longer offered. ${ids.length} compatible model${ids.length === 1 ? "" : "s"} available — using "${resolved}".`,
    };
  } catch (error) {
    const failureError = error instanceof AiError ? error : new AiError("provider_error", "Groq could not verify this key. Please retry.");
    return { ...base, ok: false, modelCount: 0, models: [], selectedModelAvailable: false, resolvedModel: null, errorCode: failureError.code, message: failureError.message };
  }
}

/** Throwing variant of `checkGroqConnection` for callers that prefer errors. */
export async function verifyGroqApiKey(input: { apiKey?: string; model?: string | null; force?: boolean; signal?: AbortSignal } = {}): Promise<KeyVerification & { selectedModel: string; selectedModelAvailable: boolean; resolvedModel: string | null }> {
  const status = await checkGroqConnection(input);
  if (!status.ok && status.errorCode) throw new AiError(status.errorCode, status.message);
  return {
    label: status.message,
    freeTier: false,
    limitRemaining: null,
    models: status.models,
    selectedModel: status.selectedModel,
    selectedModelAvailable: status.selectedModelAvailable,
    resolvedModel: status.resolvedModel,
  };
}

export type ModelResolution = {
  provider: "groq";
  /** The model the caller asked for, normalized. */
  requested: string;
  /** The verified model that will actually be used. */
  model: string;
  /** Set when `requested` is no longer offered and `model` replaced it. */
  repairedFrom: string | null;
  available: string[];
};

/**
 * Verifies the model exists before any request is made, repairing a retired
 * selection with the best available chat model. Throws `AiError` when the key
 * cannot reach any usable model.
 */
export async function resolveCompatibleModel(input: { apiKey: string; preferred?: string | null; signal?: AbortSignal }): Promise<ModelResolution> {
  const requested = normalizeGroqModelId(input.preferred) || DEFAULT_AI_MODEL;
  const key = fingerprintKey(input.apiKey);
  let models: GroqModelInfo[];
  if (modelCache && modelCache.key === key && modelCache.expiresAt > Date.now()) {
    models = modelCache.models;
  } else {
    models = await getAvailableGroqModels({ apiKey: input.apiKey, signal: input.signal });
  }
  const available = models.map(model => model.id);
  const model = pickPreferredGroqModel(available, requested);
  if (!model) throw new AiError("model_not_found", "This Groq API key cannot access any chat model. Create a new key in the Groq console, or check its model permissions.");
  return { provider: "groq", requested, model, repairedFrom: model === requested ? null : requested, available };
}

/**
 * The one place every AI feature sends a Groq request through. The model id is
 * normalized here, so the request can never carry a stale provider prefix.
 */
export async function requestGroqStructuredCompletion(request: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  temperature?: number;
  maxCompletionTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onSchemaFallback?: () => void;
}): Promise<unknown> {
  return sendGroqCompletion({ ...request, model: normalizeGroqModelId(request.model) });
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

function removeExpiredCache() {
  const now = Date.now();
  for (const [key, value] of Array.from(cache.entries())) if (value.expiresAt <= now) cache.delete(key);
  while (cache.size > AI_CACHE_MAX) cache.delete(cache.keys().next().value!);
}

function failure(error: unknown, model: string | null): AiAnalysisOutcome {
  const code = error instanceof AiError ? error.code : "provider_error";
  return {
    available: false,
    cached: false,
    model,
    report: null,
    message: error instanceof Error ? error.message : "AI is temporarily unavailable.",
    errorCode: code,
    modelRepairedFrom: null,
  };
}

/** Only these failures are worth one bounded automatic retry. */
function isTransientFailure(error: unknown): boolean {
  const code = error instanceof AiError ? error.code : null;
  return code === "network_error" || code === "provider_error" || code === "timeout";
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

type ModelResolutionOutcome =
  | { ok: true; model: string; repairedFrom: string | null; available: string[]; warning?: string }
  | { ok: false; error: AiError };

/**
 * Resolves the model for a user action. A rejected key, an unauthorized key, an
 * exhausted quota, or a key with no usable chat model stops the call; a merely
 * unreachable model list degrades to the saved model instead of blocking the
 * feature.
 */
async function resolveModelForAnalysis(input: { apiKey: string; requested: string; signal?: AbortSignal }): Promise<ModelResolutionOutcome> {
  try {
    const resolution = await resolveCompatibleModel({ apiKey: input.apiKey, preferred: input.requested, signal: input.signal });
    return { ok: true, model: resolution.model, repairedFrom: resolution.repairedFrom, available: resolution.available };
  } catch (error) {
    const normalized = error instanceof AiError ? error : new AiError("provider_error", "Groq is temporarily unavailable. Please retry.");
    const mustStop = ["invalid_key", "unauthorized", "not_configured", "model_not_found", "model_unsupported", "model_unavailable", "quota_exceeded", "cancelled"].includes(normalized.code);
    if (mustStop) return { ok: false, error: normalized };
    return {
      ok: true,
      model: normalizeGroqModelId(input.requested) || DEFAULT_AI_MODEL,
      repairedFrom: null,
      available: [],
      warning: "Groq's model list could not be verified, so the saved model was used directly.",
    };
  }
}

/** Persists a repaired model selection so the fix survives a refresh. */
function persistModelRepair(model: string) {
  try {
    updateAiModel(model);
    clearAiCache();
  } catch {
    // Persistence is best-effort; the repaired model is still used this run.
  }
}

/** Real Groq connection test: an actual request, never a key-shape check. */
export async function testAiConnection(input: { apiKey?: string; signal?: AbortSignal } = {}): Promise<KeyVerification> {
  return verifyGroqApiKey({ apiKey: input.apiKey, force: true, signal: input.signal });
}

/** Used by the settings panel to test a key before it is saved. */
export async function testGroqConnection(input: { apiKey?: string; model?: string | null; force?: boolean; signal?: AbortSignal } = {}): Promise<GroqConnectionStatus> {
  return checkGroqConnection({ ...input, force: input.force ?? true });
}

/**
 * Runs the evidence-bound performance review in the browser.
 *
 * Results are cached for fifteen minutes per service version + provider + model
 * + dataset fingerprint so a user cannot accidentally re-spend tokens by
 * re-clicking the same dataset. Failed responses are never cached.
 */
export async function analyzeJournal(input: { analysis: AnalysisResult; signal?: AbortSignal; model?: string; timeoutMs?: number }): Promise<AiAnalysisOutcome> {
  const settings = getAiSettings();
  if (!settings) return { available: false, cached: false, model: null, report: null, message: "AI is not configured. Add your Groq API key in Options; deterministic analysis remains available.", errorCode: "not_configured", modelRepairedFrom: null };
  const requested = normalizeGroqModelId(input.model ?? settings.model) || normalizeGroqModelId(settings.model) || DEFAULT_AI_MODEL;

  const resolution = await resolveModelForAnalysis({ apiKey: settings.apiKey, requested, signal: input.signal });
  if (!resolution.ok) {
    const outcome = failure(resolution.error, requested);
    outcome.message = `${resolution.error.message}${resolution.error.code === "model_not_found" ? " Open AI settings to pick an available Groq model." : ""}`;
    return outcome;
  }
  const { model, repairedFrom, available, warning } = resolution;
  if (repairedFrom) persistModelRepair(model);

  removeExpiredCache();
  const cacheKey = `${AI_SERVICE_VERSION}:${AI_PROVIDER_ID}:${model}:${analysisDataFingerprint(input.analysis)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.outcome, cached: true };

  const manifest = buildEvidenceManifest(input.analysis);
  const payload = buildAnalysisPromptPayload(input.analysis);
  let schemaFallback = false;

  const runOnce = async () => {
    const raw = await requestGroqStructuredCompletion({
      apiKey: settings.apiKey,
      model,
      system: ANALYSIS_SYSTEM_PROMPT,
      user: analysisUserPrompt(payload),
      schemaName: "gold_journal_analysis",
      schema: ANALYSIS_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0.1,
      timeoutMs: resolveAiTimeoutMs(input.timeoutMs, MAX_AI_TIMEOUT_MS),
      signal: input.signal,
      onSchemaFallback: () => { schemaFallback = true; },
    });
    const parsed = aiReportSchema.safeParse(raw);
    if (!parsed.success) throw new AiError("schema_error", "Groq returned an invalid structured analysis. Please retry.");
    if (!hasOnlyGroundedNumbers(parsed.data, payload)) throw new AiError("ungrounded_response", "Groq returned an ungrounded numerical claim, so the report was rejected. Please retry.");
    if (!validateEvidenceReport(parsed.data, manifest)) throw new AiError("ungrounded_response", "Groq returned an evidence claim that does not match the supplied evidence, so the report was rejected. Please retry.");
    return parsed.data;
  };

  try {
    let report: AiReport | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        report = await runOnce();
        break;
      } catch (error) {
        if (attempt < TRANSIENT_RETRY_LIMIT && isTransientFailure(error) && !input.signal?.aborted) {
          await delay(TRANSIENT_RETRY_DELAY_MS, input.signal);
          continue;
        }
        throw error;
      }
    }
    if (!report) throw new AiError("provider_error", "Groq returned no report. Please retry.");
    const outcome: AiAnalysisOutcome = { available: true, cached: false, model, report, modelRepairedFrom: repairedFrom, availableModels: available, warning, schemaFallback };
    cache.set(cacheKey, { expiresAt: Date.now() + AI_CACHE_TTL_MS, outcome });
    return outcome;
  } catch (error) {
    return { ...failure(error, model), modelRepairedFrom: repairedFrom, availableModels: available, warning };
  }
}

/** Consistent, credential-free copy for each AI UI state. */
export const AI_UI_COPY: Record<AiUiState, { title: string; body: string }> = {
  not_configured: { title: "AI is not configured", body: "Add your Groq API key in Options to enable AI. Deterministic analysis and journaling keep working without it." },
  ready: { title: "AI is ready", body: "Your key is stored only in this browser and requests go straight to Groq." },
  analyzing: { title: "Analyzing…", body: "Waiting for Groq to return an evidence-bound response." },
  success: { title: "Analysis complete", body: "Review the evidence-bound report below." },
  invalid_key: { title: "Groq rejected this key", body: "Check the API key in AI settings, then retry." },
  unauthorized: { title: "Groq is not authorized for this key", body: "The key is valid but its project permissions do not allow this request. Check the key's permissions in the Groq console." },
  model_not_found: { title: "Selected Groq model is unavailable", body: "This model is no longer offered for your key. Open AI settings and choose an available Groq model." },
  model_unsupported: { title: "Selected Groq model cannot run this request", body: "Pick a Groq chat model (GPT-OSS or Llama) in AI settings, then retry." },
  model_unavailable: { title: "Selected Groq model is temporarily unavailable", body: "Open AI settings and choose another Groq model, then retry." },
  rate_limited: { title: "Rate limited", body: "Groq is throttling this key. Wait a moment and retry." },
  quota_exceeded: { title: "Groq quota reached", body: "This key's quota or billing limit is exhausted. Check your Groq plan or wait for the quota window to reset." },
  network_error: { title: "No connection to Groq", body: "Check your internet connection and retry. Your journal data is unaffected." },
  provider_error: { title: "Groq request failed", body: "Groq or the selected model failed. Retry, or choose a different model in AI settings." },
  timeout: { title: "AI timed out", body: "The request exceeded its time budget and was cancelled. Retry or pick a faster model." },
  cancelled: { title: "Cancelled", body: "The request was cancelled before completion." },
  invalid_request: { title: "Groq rejected the request", body: "The request shape was rejected. Retry, or choose a different Groq model in AI settings." },
  schema_error: { title: "AI report failed local validation", body: "Groq's response was rejected by the local schema and evidence-grounding checks, so no report was produced and nothing was saved. Retry, or choose another Groq model." },
  blocked: { title: "Groq blocked the response", body: "The model refused this response. Adjust the journal data wording and retry." },
};
