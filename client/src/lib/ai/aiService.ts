/**
 * The single browser AI service used by Analyze My Trade, the AI Mentor, AI
 * reports, and AI settings.
 *
 * The Risk Calculator is deliberately absent from this module: position sizing
 * is deterministic and broker-aware, and it must keep working when no key is
 * configured, Gemini is unreachable, or the internet is offline.
 *
 * Provider: Google AI Studio (Gemini) — exclusively. There is no OpenRouter or
 * OpenAI path anywhere in the active execution path. This module is the one
 * source of truth for Gemini configuration and exposes:
 *
 *   getAiSettings()                    — the stored credential + model
 *   verifyGeminiApiKey()               — live key + model status
 *   getAvailableGeminiModels()         — models this key can actually call
 *   resolveCompatibleModel()           — verifies/repairs the selected model
 *   requestGeminiStructuredCompletion() — one validated Gemini request
 *
 * Every call:
 *  1. reads the credential from local browser storage,
 *  2. verifies the selected model against the live Gemini model list,
 *  3. calls Google AI directly over HTTPS,
 *  4. validates the structured response against the shared schema and grounding
 *     rules, and
 *  5. returns a normalized outcome the UI can render.
 *
 * It never runs on a schedule, on page load, or on journal updates: only an
 * explicit user action starts a request.
 */
import {
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
  normalizeGeminiModelId,
  pickPreferredGeminiModel,
  resolveAiTimeoutMs,
  stableHash16,
  validateEvidenceReport,
  type AiReport,
} from "@shared/aiCore";
import type { AnalysisResult } from "@shared/analysisEngine";
import { maskApiKey, readAiSettings, readAiSettingsView, subscribeAiSettings, updateAiModel } from "./aiStorage";
import { AiError, type AiErrorCode, type AiSettings, type AiSettingsView, type AiUiState } from "./aiTypes";
import { listGeminiModels, requestStructuredCompletion, type GeminiModelInfo, type KeyVerification } from "./geminiClient";

const AI_CACHE_TTL_MS = 15 * 60_000;
const AI_CACHE_MAX = 64;
const MODEL_CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { expiresAt: number; outcome: AiAnalysisOutcome }>();
let modelCache: { key: string; expiresAt: number; models: GeminiModelInfo[] } | null = null;

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
  /** True when Gemini rejected the strict schema and JSON-only mode was used. */
  schemaFallback?: boolean;
};

/* ------------------------------------------------------------------ *
 * Central configuration
 * ------------------------------------------------------------------ */

/** The stored Gemini credential. This is the only reader of the raw key. */
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

function fingerprintKey(apiKey: string) {
  // The map key is a digest, so the raw credential never sits in a cache key.
  return stableHash16(apiKey);
}

/**
 * Models this key can actually call for text generation. Results are cached for
 * ten minutes per key digest to keep analysis to a single network round trip.
 */
export async function getAvailableGeminiModels(input: { apiKey?: string; force?: boolean; signal?: AbortSignal } = {}): Promise<GeminiModelInfo[]> {
  const apiKey = input.apiKey?.trim() || getAiSettings()?.apiKey;
  if (!apiKey) throw new AiError("not_configured", "Add your Google AI Studio API key first.");
  const key = fingerprintKey(apiKey);
  if (!input.force && modelCache && modelCache.key === key && modelCache.expiresAt > Date.now()) return modelCache.models;
  const models = await listGeminiModels(apiKey, { signal: input.signal });
  modelCache = { key, expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models };
  return models;
}

export type GeminiConnectionStatus = {
  provider: "gemini";
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
 * Verifies the key against Gemini's live model listing, then confirms the
 * selected model exists and supports `generateContent`. Returns a status object;
 * use `verifyGeminiApiKey` when a thrown error is more convenient.
 */
export async function checkGeminiConnection(input: { apiKey?: string; model?: string | null; force?: boolean; signal?: AbortSignal } = {}): Promise<GeminiConnectionStatus> {
  const settings = getAiSettings();
  const apiKey = input.apiKey?.trim() || settings?.apiKey || "";
  const requested = normalizeGeminiModelId(input.model ?? settings?.model ?? DEFAULT_AI_MODEL);
  const base = { provider: "gemini" as const, maskedKey: apiKey ? maskApiKey(apiKey) : null, selectedModel: requested };
  if (!apiKey) {
    return { ...base, ok: false, modelCount: 0, models: [], selectedModelAvailable: false, resolvedModel: null, errorCode: "not_configured", message: "Add your Google AI Studio API key first." };
  }
  try {
    const models = await getAvailableGeminiModels({ apiKey, force: input.force, signal: input.signal });
    const ids = models.map(model => model.id);
    const resolved = pickPreferredGeminiModel(ids, requested);
    if (!resolved) {
      return { ...base, ok: false, modelCount: 0, models: [], selectedModelAvailable: false, resolvedModel: null, errorCode: "model_not_found", message: "This Gemini API key cannot access any text generation model. Check the key's project restrictions in Google AI Studio." };
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
        ? `Gemini connected — API key valid. ${ids.length} compatible model${ids.length === 1 ? "" : "s"} available.`
        : `Gemini API key valid, but "${requested}" is no longer offered. ${ids.length} compatible model${ids.length === 1 ? "" : "s"} available — using "${resolved}".`,
    };
  } catch (error) {
    const failureError = error instanceof AiError ? error : new AiError("provider_error", "Gemini could not verify this key. Please retry.");
    return { ...base, ok: false, modelCount: 0, models: [], selectedModelAvailable: false, resolvedModel: null, errorCode: failureError.code, message: failureError.message };
  }
}

/** Throwing variant of `checkGeminiConnection` for callers that prefer errors. */
export async function verifyGeminiApiKey(input: { apiKey?: string; model?: string | null; force?: boolean; signal?: AbortSignal } = {}): Promise<KeyVerification & { selectedModel: string; selectedModelAvailable: boolean; resolvedModel: string | null }> {
  const status = await checkGeminiConnection(input);
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
  provider: "gemini";
  /** The model the caller asked for, normalized. */
  requested: string;
  /** The verified model that will actually be used. */
  model: string;
  /** Set when `requested` is no longer offered and `model` replaced it. */
  repairedFrom: string | null;
  available: string[];
};

/**
 * Verifies the model exists **and** supports `generateContent` before any
 * request is made, repairing a retired selection with the best available
 * generation model. Throws `AiError` when the key cannot reach any usable model.
 */
export async function resolveCompatibleModel(input: { apiKey: string; preferred?: string | null; signal?: AbortSignal }): Promise<ModelResolution> {
  const requested = normalizeGeminiModelId(input.preferred) || DEFAULT_AI_MODEL;
  const key = fingerprintKey(input.apiKey);
  let models: GeminiModelInfo[];
  if (modelCache && modelCache.key === key && modelCache.expiresAt > Date.now()) {
    models = modelCache.models;
  } else {
    models = await getAvailableGeminiModels({ apiKey: input.apiKey, signal: input.signal });
  }
  const available = models.map(model => model.id);
  const model = pickPreferredGeminiModel(available, requested);
  if (!model) throw new AiError("model_not_found", "This Gemini API key cannot access any text generation model. Create a new key in Google AI Studio, or check its project restrictions.");
  return { provider: "gemini", requested, model, repairedFrom: model === requested ? null : requested, available };
}

/**
 * The one place every AI feature sends a Gemini request through. The model id
 * is normalized here, so `models/models/…` can never be sent.
 */
export async function requestGeminiStructuredCompletion(request: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onSchemaFallback?: () => void;
}): Promise<unknown> {
  return requestStructuredCompletion({ ...request, model: normalizeGeminiModelId(request.model) });
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

type ModelResolutionOutcome =
  | { ok: true; model: string; repairedFrom: string | null; available: string[]; warning?: string }
  | { ok: false; error: AiError };

/**
 * Resolves the model for a user action. A rejected key, an exhausted quota, or
 * a key with no usable generation model stops the call; a merely unreachable
 * model list degrades to the saved model instead of blocking the feature.
 */
async function resolveModelForAnalysis(input: { apiKey: string; requested: string; signal?: AbortSignal }): Promise<ModelResolutionOutcome> {
  try {
    const resolution = await resolveCompatibleModel({ apiKey: input.apiKey, preferred: input.requested, signal: input.signal });
    return { ok: true, model: resolution.model, repairedFrom: resolution.repairedFrom, available: resolution.available };
  } catch (error) {
    const normalized = error instanceof AiError ? error : new AiError("provider_error", "Gemini is temporarily unavailable. Please retry.");
    const mustStop = ["invalid_key", "not_configured", "model_not_found", "model_unsupported", "quota_exceeded", "cancelled"].includes(normalized.code);
    if (mustStop) return { ok: false, error: normalized };
    return {
      ok: true,
      model: normalizeGeminiModelId(input.requested) || DEFAULT_AI_MODEL,
      repairedFrom: null,
      available: [],
      warning: "Gemini's model list could not be verified, so the saved model was used directly.",
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

export async function testAiConnection(input: { apiKey?: string; signal?: AbortSignal } = {}): Promise<KeyVerification> {
  return verifyGeminiApiKey({ apiKey: input.apiKey, force: true, signal: input.signal });
}

/**
 * Runs the evidence-bound performance review in the browser.
 *
 * Results are cached for fifteen minutes per service version + model + dataset
 * fingerprint so a user cannot accidentally re-spend tokens by re-clicking the
 * same dataset. Failed responses are never cached.
 */
export async function analyzeJournal(input: { analysis: AnalysisResult; signal?: AbortSignal; model?: string; timeoutMs?: number }): Promise<AiAnalysisOutcome> {
  const settings = getAiSettings();
  if (!settings) return { available: false, cached: false, model: null, report: null, message: "AI is not configured. Add your Google AI Studio key in Options; deterministic analysis remains available.", errorCode: "not_configured", modelRepairedFrom: null };
  const requested = normalizeGeminiModelId(input.model ?? settings.model) || normalizeGeminiModelId(settings.model) || DEFAULT_AI_MODEL;

  const resolution = await resolveModelForAnalysis({ apiKey: settings.apiKey, requested, signal: input.signal });
  if (!resolution.ok) {
    const outcome = failure(resolution.error, requested);
    outcome.message = `${resolution.error.message}${resolution.error.code === "model_not_found" ? " Open AI settings to pick an available Gemini model." : ""}`;
    return outcome;
  }
  const { model, repairedFrom, available, warning } = resolution;
  if (repairedFrom) persistModelRepair(model);

  removeExpiredCache();
  const cacheKey = `${AI_SERVICE_VERSION}:${model}:${analysisDataFingerprint(input.analysis)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.outcome, cached: true };

  const manifest = buildEvidenceManifest(input.analysis);
  const payload = buildAnalysisPromptPayload(input.analysis);
  let schemaFallback = false;
  try {
    const raw = await requestGeminiStructuredCompletion({
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
    if (!parsed.success) throw new AiError("schema_error", "Gemini returned an invalid structured analysis. Please retry.");
    if (!hasOnlyGroundedNumbers(parsed.data, payload)) throw new AiError("ungrounded_response", "Gemini returned an ungrounded numerical claim, so the report was rejected. Please retry.");
    if (!validateEvidenceReport(parsed.data, manifest)) throw new AiError("ungrounded_response", "Gemini returned an evidence claim that does not match the supplied evidence, so the report was rejected. Please retry.");
    const outcome: AiAnalysisOutcome = { available: true, cached: false, model, report: parsed.data, modelRepairedFrom: repairedFrom, availableModels: available, warning, schemaFallback };
    cache.set(cacheKey, { expiresAt: Date.now() + AI_CACHE_TTL_MS, outcome });
    return outcome;
  } catch (error) {
    return { ...failure(error, model), modelRepairedFrom: repairedFrom, availableModels: available, warning };
  }
}

/** Consistent, credential-free copy for each AI UI state. */
export const AI_UI_COPY: Record<AiUiState, { title: string; body: string }> = {
  not_configured: { title: "AI is not configured", body: "Add your Google AI Studio API key in Options to enable AI. Deterministic analysis and journaling keep working without it." },
  ready: { title: "AI is ready", body: "Your key is stored only in this browser and requests go straight to Gemini." },
  analyzing: { title: "Analyzing…", body: "Waiting for Gemini to return an evidence-bound response." },
  success: { title: "Analysis complete", body: "Review the evidence-bound report below." },
  invalid_key: { title: "Gemini rejected this key", body: "Check the API key in AI settings, then retry." },
  model_not_found: { title: "Selected Gemini model is unavailable", body: "This model is no longer offered for your key. Open AI settings and choose an available Gemini model." },
  model_unsupported: { title: "Selected Gemini model cannot generate content", body: "Pick a Gemini text generation model (Flash or Pro) in AI settings, then retry." },
  rate_limited: { title: "Rate limited", body: "Gemini is throttling this key. Wait a moment and retry." },
  quota_exceeded: { title: "Gemini quota reached", body: "This key's quota or billing limit is exhausted. Check your Google AI Studio plan or wait for the quota window to reset." },
  network_error: { title: "No connection to Gemini", body: "Check your internet connection and retry. Your journal data is unaffected." },
  provider_error: { title: "Gemini request failed", body: "Gemini or the selected model failed. Retry, or choose a different model in AI settings." },
  timeout: { title: "AI timed out", body: "The request exceeded its time budget and was cancelled. Retry or pick a faster model." },
  cancelled: { title: "Cancelled", body: "The request was cancelled before completion." },
  invalid_request: { title: "Gemini rejected the request", body: "The request shape was rejected. Retry, or choose a different Gemini model in AI settings." },
  schema_error: { title: "AI report failed local validation", body: "Gemini's response was rejected by the local schema and evidence-grounding checks, so no report was produced and nothing was saved. Retry, or choose another Gemini model." },
  blocked: { title: "Gemini blocked the response", body: "Safety filters stopped this response. Adjust the journal data wording and retry." },
};
