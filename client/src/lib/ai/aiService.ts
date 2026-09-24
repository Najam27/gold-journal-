/**
 * The single browser AI service used by Analyze My Trade, the AI Mentor, AI
 * reports, and AI settings.
 *
 * The Risk Calculator is deliberately absent from this module: position sizing
 * is deterministic and broker-aware, and it must keep working when no key is
 * configured, both providers are unreachable, or the internet is offline.
 *
 * Providers — Google Gemini and Groq, both optional
 * ------------------------------------------------
 * The user may configure one, both, or neither, and both credentials live only in
 * this browser. Requests go straight from the browser to the provider's HTTPS
 * API. There is no backend, Worker, or serverless function in the AI path.
 *
 * Routing:
 *
 *  1. Every configured provider is tried in the user's fallback order
 *     (Gemini first by default). If Gemini fails for any recoverable reason —
 *     bad key, missing model, quota, outage, oversized request, a response that
 *     cannot be repaired — Groq is used automatically, and vice versa.
 *  2. A retryable network failure gets a bounded exponential backoff
 *     (3 attempts). A 413 is never retried unchanged: the provider's own stated
 *     limit is adopted, the payload is rebuilt strictly smaller, and it is
 *     re-sent exactly once.
 *  3. Local validation **repairs** a provider response instead of rejecting the
 *     whole report: verified numbers are overwritten from the deterministic
 *     manifest, and only the individual claims that cannot be repaired are
 *     dropped. Optional AI insight can therefore never invalidate the report.
 *  4. If every configured provider fails, a complete **deterministic report**
 *     built from the local analysis engine is returned. A provider outage can
 *     never make the report disappear.
 *
 * It never runs on a schedule, on page load, or on journal updates: only an
 * explicit user action starts a request, and an identical request already in
 * flight is joined rather than duplicated.
 */
import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_META,
  AI_SERVICE_VERSION,
  ANALYSIS_CHUNK_RESPONSE_SCHEMA,
  ANALYSIS_CHUNK_SCHEMA_NAME,
  ANALYSIS_CHUNK_SYSTEM_PROMPT,
  ANALYSIS_RESPONSE_SCHEMA,
  ANALYSIS_SYSTEM_PROMPT,
  DEFAULT_AI_MODEL,
  DEFAULT_GEMINI_MODEL,
  MAX_AI_TIMEOUT_MS,
  aiChunkSummarySchema,
  analysisChunkUserPrompt,
  analysisDataFingerprint,
  analysisUserPrompt,
  buildDeterministicReport,
  buildEvidenceManifest,
  normalizeGeminiModelId,
  normalizeGroqModelId,
  pickPreferredGeminiModel,
  pickPreferredGroqModel,
  reportIsEmpty,
  resolveAiTimeoutMs,
  sanitizeAiReport,
  stableHash16,
  type AiChunkSummary,
  type AiProviderId,
  type AiReport,
} from "@shared/aiCore";
import type { AnalysisResult } from "@shared/analysisEngine";
import {
  AI_REQUEST_VERSION,
  AI_TOKEN_POLICY,
  getProviderRequestPolicy,
  recordRefusedRequest,
  resetWorkingTokenAllowance,
  type AiRequestStats,
} from "@shared/aiBudget";
import {
  buildSynthesisPayload,
  planAiRequest,
  type AiAnalysisInput,
  type AiRequestPlan,
  type CompactTrade,
} from "@shared/aiPayload";
import {
  activeProviderId,
  clearProviderSettings,
  configuredProviderIds,
  maskApiKey,
  purgeLegacyProviderSettings,
  readAiProviderBundle,
  readAiSettings,
  readAiSettingsView,
  saveProviderSettings,
  subscribeAiSettings,
  updateProviderModel,
  type AiProviderBundle,
} from "./aiStorage";
import { AiError, type AiErrorCode, type AiSettings, type AiSettingsView, type AiUiState } from "./aiTypes";
import {
  listGeminiModels,
  requestGeminiStructuredCompletion,
  type GeminiModelInfo,
} from "./geminiClient";
import { listGroqModels, requestGroqStructuredCompletion as sendGroqStructuredCompletion, type GroqModelInfo } from "./groqClient";

const AI_CACHE_TTL_MS = 15 * 60_000;
const AI_CACHE_MAX = 64;
const MODEL_CACHE_TTL_MS = 10 * 60_000;

/**
 * Bounded retry policy: attempt 1, wait, attempt 2, wait, attempt 3, then fail.
 * Only transient failures are retried — never an invalid key, a missing model, a
 * rejected request, or a 413.
 */
const TRANSIENT_MAX_ATTEMPTS = 3;
const TRANSIENT_BASE_DELAY_MS = 600;

/** Feature the request belongs to. Part of the deduplication key and diagnostics. */
export type AiFeature = "analysis" | "mentor";

/** Progress callback so the UI can show an accurate batch message. */
export type AiAnalysisProgress = { phase: "preparing" | "chunk" | "synthesis"; index: number; total: number };

/** Provider-neutral model entry returned by every discovery path. */
export type AiModelInfo = { id: string; label: string };

/** One provider that was tried and failed during automatic fallback. */
export type AiProviderFailure = { provider: AiProviderId; code: AiErrorCode; message: string };

const cache = new Map<string, { expiresAt: number; outcome: AiAnalysisOutcome }>();
const modelCaches: Record<AiProviderId, { key: string; expiresAt: number; models: AiModelInfo[] } | null> = { gemini: null, groq: null };
const inFlight = new Map<string, Promise<AiAnalysisOutcome>>();
const modelListInFlight: Record<AiProviderId, Promise<AiModelInfo[]> | null> = { gemini: null, groq: null };
const connectionInFlight = new Map<string, Promise<ProviderConnectionStatus>>();

/** Legacy-compatible outcome shape so existing report renderers stay valid. */
export type AiAnalysisOutcome = {
  /** True when a report is present — AI or deterministic. */
  available: boolean;
  cached: boolean;
  /** Provider that produced the report, or null for a deterministic report. */
  provider: AiProviderId | null;
  model: string | null;
  report: AiReport | null;
  /** True when the report was built locally because no provider succeeded. */
  deterministic?: boolean;
  /** What was repaired in an AI report so it could be kept instead of rejected. */
  repairs?: string[];
  /** Every provider that was tried and failed, in the order they were tried. */
  providerErrors?: AiProviderFailure[];
  message?: string;
  errorCode?: AiErrorCode;
  /** Set when a saved model was retired and a verified model replaced it. */
  modelRepairedFrom?: string | null;
  /** Models the provider could call at the time of the call. Never contains a key. */
  availableModels?: string[];
  /** Non-fatal note, e.g. the model list could not be verified. */
  warning?: string;
  /** True when the provider rejected the strict schema and JSON-object mode was used. */
  schemaFallback?: boolean;
  /** How the request was executed. */
  requestMode?: "single" | "chunked";
  /** True when this call joined an identical request that was already running. */
  deduplicated?: boolean;
  /** True when the app rebuilt a smaller payload after a 413. */
  reducedAfterTooLarge?: boolean;
  /** Credential-free, journal-content-free request metadata for diagnostics. */
  requestStats?: AiRequestStats;
};

/* ------------------------------------------------------------------ *
 * Central configuration
 * ------------------------------------------------------------------ */

/** The active provider's stored credential. The only reader of a raw key. */
export function getAiSettings(): (AiSettings & { provider: AiProviderId }) | null {
  return readAiSettings();
}

export function aiSettingsStatus(): AiSettingsView {
  return readAiSettingsView();
}

export function isAiConfigured(): boolean {
  return readAiSettings() !== null;
}

/** Providers that hold a credential, in fallback order. */
export function getConfiguredProviders(): AiProviderId[] {
  return configuredProviderIds(readAiProviderBundle());
}

/** Drops every cached result and every cached model list. */
export function clearAiCache() {
  cache.clear();
  modelCaches.gemini = null;
  modelCaches.groq = null;
}

/** Clears the learned token allowance so sizing returns to its conservative default. */
export function resetAiTokenBudget() {
  resetWorkingTokenAllowance();
}

/**
 * Settings can change in another tab or through the settings panel. Any change
 * invalidates the model lists and every cached report so a stale model or a
 * failed result can never be replayed as current.
 */
subscribeAiSettings(clearAiCache);

/**
 * Runs once when the AI layer loads (i.e. on app start, since every AI surface
 * imports this module): credentials stored under a retired provider's namespace
 * are deleted, and the legacy single-provider Gemini/Groq records are migrated.
 */
purgeLegacyProviderSettings();

function fingerprintKey(apiKey: string) {
  // The map key is a digest, so the raw credential never sits in a cache key.
  return stableHash16(apiKey);
}

function providerLabel(provider: AiProviderId) {
  return AI_PROVIDER_META[provider].label;
}

function defaultModelFor(provider: AiProviderId) {
  return provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_AI_MODEL;
}

/* ------------------------------------------------------------------ *
 * Model discovery
 * ------------------------------------------------------------------ */

/**
 * Models one provider key can actually call. Results are cached for ten minutes
 * per key digest, and concurrent callers share one request so a double-click
 * cannot issue two model listings.
 */
export async function listProviderModels(
  provider: AiProviderId,
  input: { apiKey?: string; force?: boolean; signal?: AbortSignal } = {}
): Promise<AiModelInfo[]> {
  const stored = readAiProviderBundle().providers[provider] ?? null;
  const apiKey = input.apiKey?.trim() || stored?.apiKey;
  if (!apiKey) throw new AiError("not_configured", `Add your ${providerLabel(provider)} API key first.`);
  const key = fingerprintKey(apiKey);
  const cached = modelCaches[provider];
  if (!input.force && cached && cached.key === key && cached.expiresAt > Date.now()) return cached.models;
  const running = modelListInFlight[provider];
  if (running) return running;
  const load = provider === "gemini"
    ? listGeminiModels(apiKey, { signal: input.signal }).then(models => models.map(model => ({ id: model.id, label: model.label })))
    : listGroqModels(apiKey, { signal: input.signal }).then(models => models.map(model => ({ id: model.id, label: model.label })));
  const pending = load
    .then(models => {
      modelCaches[provider] = { key, expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models };
      return models;
    })
    .finally(() => { modelListInFlight[provider] = null; });
  modelListInFlight[provider] = pending;
  return pending;
}

/** Groq models, kept for the existing settings panel and tests. */
export async function getAvailableGroqModels(input: { apiKey?: string; force?: boolean; signal?: AbortSignal } = {}): Promise<GroqModelInfo[]> {
  const models = await listProviderModels("groq", input);
  return models.map(model => ({ id: model.id, label: model.label, contextWindow: null }));
}

/** Gemini models this key can call. */
export async function getAvailableGeminiModels(input: { apiKey?: string; force?: boolean; signal?: AbortSignal } = {}): Promise<GeminiModelInfo[]> {
  const models = await listProviderModels("gemini", input);
  return models.map(model => ({ id: model.id, label: model.label, inputTokenLimit: null, outputTokenLimit: null }));
}

/* ------------------------------------------------------------------ *
 * Connection status
 * ------------------------------------------------------------------ */

export type ProviderConnectionStatus = {
  provider: AiProviderId;
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

/** Backwards-compatible alias: the Groq status is a provider status. */
export type GroqConnectionStatus = ProviderConnectionStatus;

/**
 * Verifies one provider's key against its live model listing, then confirms the
 * selected model exists. Returns a status object rather than throwing so the
 * settings panel can render a saved-but-broken credential.
 */
export async function checkProviderConnection(
  provider: AiProviderId,
  input: { apiKey?: string; model?: string | null; force?: boolean; signal?: AbortSignal } = {}
): Promise<ProviderConnectionStatus> {
  const bundle = readAiProviderBundle();
  const stored = bundle.providers[provider] ?? null;
  const apiKey = input.apiKey?.trim() || stored?.apiKey || "";
  const normalize = provider === "gemini" ? normalizeGeminiModelId : normalizeGroqModelId;
  const pick = provider === "gemini" ? pickPreferredGeminiModel : pickPreferredGroqModel;
  const requested = normalize(input.model ?? stored?.model ?? defaultModelFor(provider)) || defaultModelFor(provider);
  const base = { provider, maskedKey: apiKey ? maskApiKey(apiKey) : null, selectedModel: requested };
  if (!apiKey) {
    return { ...base, ok: false, modelCount: 0, models: [], selectedModelAvailable: false, resolvedModel: null, errorCode: "not_configured", message: `Add your ${providerLabel(provider)} API key first.` };
  }
  const dedupeKey = `${provider}:${fingerprintKey(apiKey)}:${requested}:${input.force ? "force" : "cached"}`;
  const existing = connectionInFlight.get(dedupeKey);
  if (existing) return existing;
  const pending = (async (): Promise<ProviderConnectionStatus> => {
    try {
      const models = await listProviderModels(provider, { apiKey, force: input.force, signal: input.signal });
      const ids = models.map(model => model.id);
      const resolved = pick(ids, requested);
      if (!resolved) {
        return { ...base, ok: false, modelCount: 0, models: [], selectedModelAvailable: false, resolvedModel: null, errorCode: "model_not_found", message: `This ${providerLabel(provider)} API key cannot access any chat model. Check the key's project and model permissions.` };
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
          ? `${providerLabel(provider)} connected successfully. ${ids.length} compatible model${ids.length === 1 ? "" : "s"} available.`
          : `${providerLabel(provider)} accepted this API key, but "${requested}" is no longer offered. ${ids.length} compatible model${ids.length === 1 ? "" : "s"} available — using "${resolved}".`,
      };
    } catch (error) {
      const failureError = error instanceof AiError ? error : new AiError("provider_error", `${providerLabel(provider)} could not verify this key. Please retry.`);
      return { ...base, ok: false, modelCount: 0, models: [], selectedModelAvailable: false, resolvedModel: null, errorCode: failureError.code, message: failureError.message };
    } finally {
      connectionInFlight.delete(dedupeKey);
    }
  })();
  connectionInFlight.set(dedupeKey, pending);
  return pending;
}

/** Groq connection status, retained for the existing settings panel and tests. */
export async function checkGroqConnection(input: { apiKey?: string; model?: string | null; force?: boolean; signal?: AbortSignal } = {}): Promise<GroqConnectionStatus> {
  return checkProviderConnection("groq", input);
}

/** Gemini connection status. */
export async function checkGeminiConnection(input: { apiKey?: string; model?: string | null; force?: boolean; signal?: AbortSignal } = {}): Promise<ProviderConnectionStatus> {
  return checkProviderConnection("gemini", input);
}

/** Every configured provider's status, in fallback order. Never throws. */
export async function checkAllConnections(input: { force?: boolean; signal?: AbortSignal } = {}): Promise<ProviderConnectionStatus[]> {
  const providers = getConfiguredProviders();
  return Promise.all(providers.map(provider => checkProviderConnection(provider, { force: input.force, signal: input.signal })));
}

/** Throwing variant of `checkGroqConnection` for callers that prefer errors. */
export async function verifyGroqApiKey(input: { apiKey?: string; model?: string | null; force?: boolean; signal?: AbortSignal } = {}) {
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

/** Real connection test: an actual request, never a key-shape check. */
export async function testAiConnection(input: { apiKey?: string; signal?: AbortSignal } = {}) {
  return verifyGroqApiKey({ apiKey: input.apiKey, force: true, signal: input.signal });
}

/** Used by the settings panel to test a provider key before it is saved. */
export async function testProviderConnection(provider: AiProviderId, input: { apiKey?: string; model?: string | null; force?: boolean; signal?: AbortSignal } = {}) {
  return checkProviderConnection(provider, { ...input, force: input.force ?? true });
}

/** Kept for the existing Groq settings panel. */
export async function testGroqConnection(input: { apiKey?: string; model?: string | null; force?: boolean; signal?: AbortSignal } = {}) {
  return checkGroqConnection({ ...input, force: input.force ?? true });
}

/* ------------------------------------------------------------------ *
 * Model resolution
 * ------------------------------------------------------------------ */

export type ModelResolution = {
  provider: AiProviderId;
  /** The model the caller asked for, normalized. */
  requested: string;
  /** The verified model that will actually be used. */
  model: string;
  /** Set when `requested` is no longer offered and `model` replaced it. */
  repairedFrom: string | null;
  available: string[];
};

/**
 * Verifies a model exists before any request is made, repairing a retired
 * selection with the best available chat model for that provider. Throws
 * `AiError` when the key cannot reach any usable model.
 */
export async function resolveCompatibleModel(input: { provider?: AiProviderId; apiKey: string; preferred?: string | null; signal?: AbortSignal }): Promise<ModelResolution> {
  const provider = input.provider ?? "groq";
  const normalize = provider === "gemini" ? normalizeGeminiModelId : normalizeGroqModelId;
  const pick = provider === "gemini" ? pickPreferredGeminiModel : pickPreferredGroqModel;
  const requested = normalize(input.preferred) || defaultModelFor(provider);
  const models = await listProviderModels(provider, { apiKey: input.apiKey, signal: input.signal });
  const available = models.map(model => model.id);
  const model = pick(available, requested);
  if (!model) throw new AiError("model_not_found", `This ${providerLabel(provider)} API key cannot access any chat model. Create a new key, or check its model permissions.`);
  return { provider, requested, model, repairedFrom: model === requested ? null : requested, available };
}

type ModelResolutionOutcome =
  | { ok: true; model: string; repairedFrom: string | null; available: string[]; warning?: string }
  | { ok: false; error: AiError };

/**
 * Resolves the model for a user action. A rejected key, an unauthorized key, an
 * exhausted quota, or a key with no usable chat model stops *that provider*; a
 * merely unreachable model list degrades to the saved model instead of blocking
 * the feature.
 *
 * Stopping a provider never stops the analysis: the caller falls back to the
 * next configured provider and, ultimately, to the deterministic report.
 */
async function resolveModelForAnalysis(input: { provider: AiProviderId; apiKey: string; requested: string; signal?: AbortSignal }): Promise<ModelResolutionOutcome> {
  try {
    const resolution = await resolveCompatibleModel({ provider: input.provider, apiKey: input.apiKey, preferred: input.requested, signal: input.signal });
    return { ok: true, model: resolution.model, repairedFrom: resolution.repairedFrom, available: resolution.available };
  } catch (error) {
    const normalized = error instanceof AiError ? error : new AiError("provider_error", `${providerLabel(input.provider)} is temporarily unavailable. Please retry.`);
    const mustStop = ["invalid_key", "unauthorized", "not_configured", "model_not_found", "model_unsupported", "model_unavailable", "quota_exceeded", "cancelled"].includes(normalized.code);
    if (mustStop) return { ok: false, error: normalized };
    const normalize = input.provider === "gemini" ? normalizeGeminiModelId : normalizeGroqModelId;
    return {
      ok: true,
      model: normalize(input.requested) || defaultModelFor(input.provider),
      repairedFrom: null,
      available: [],
      warning: `${providerLabel(input.provider)}'s model list could not be verified, so the saved model was used directly.`,
    };
  }
}

/** Persists a repaired model selection so the fix survives a refresh. */
function persistModelRepair(provider: AiProviderId, model: string) {
  try {
    updateProviderModel(provider, model);
    clearAiCache();
  } catch {
    // Persistence is best-effort; the repaired model is still used this run.
  }
}

/* ------------------------------------------------------------------ *
 * Transport dispatch
 * ------------------------------------------------------------------ */

type StructuredRequest = {
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
};

/**
 * The one place every AI feature sends a request through. Both transports share
 * this contract, so the router below never branches on provider-specific shapes.
 */
export async function requestProviderStructuredCompletion(provider: AiProviderId, request: StructuredRequest): Promise<unknown> {
  if (provider === "gemini") return requestGeminiStructuredCompletion(request);
  return sendGroqStructuredCompletion({ ...request, model: normalizeGroqModelId(request.model) });
}

/** Kept for callers that explicitly target Groq. */
export async function requestGroqStructuredCompletion(request: StructuredRequest): Promise<unknown> {
  return requestProviderStructuredCompletion("groq", request);
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

function removeExpiredCache() {
  const now = Date.now();
  for (const [key, value] of Array.from(cache.entries())) if (value.expiresAt <= now) cache.delete(key);
  while (cache.size > AI_CACHE_MAX) cache.delete(cache.keys().next().value!);
}

function failure(error: unknown, provider: AiProviderId | null, model: string | null): AiAnalysisOutcome {
  const code = error instanceof AiError ? error.code : "provider_error";
  return {
    available: false,
    cached: false,
    provider,
    model,
    report: null,
    message: error instanceof Error ? error.message : "AI is temporarily unavailable.",
    errorCode: code,
    modelRepairedFrom: null,
  };
}

/**
 * Only these failures are worth an automatic retry. A 413 is deliberately
 * excluded: the same bytes would be rejected identically, so it is handled by
 * shrinking the payload instead.
 */
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

/** Bounded exponential backoff: 600 ms, then 1800 ms, then give up. */
async function sendWithBackoff(provider: AiProviderId, args: StructuredRequest, signal?: AbortSignal): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_MAX_ATTEMPTS; attempt++) {
    try {
      return await requestProviderStructuredCompletion(provider, args);
    } catch (error) {
      lastError = error;
      if (attempt >= TRANSIENT_MAX_ATTEMPTS || !isTransientFailure(error) || signal?.aborted) throw error;
      await delay(TRANSIENT_BASE_DELAY_MS * 3 ** (attempt - 1), signal);
    }
  }
  throw lastError;
}

/**
 * Turns a provider response into a report the app can trust.
 *
 * Repair-first by design: every verified number is overwritten from the
 * deterministic manifest and only the individual claims that cannot be repaired
 * are dropped. A single bad optional insight can therefore never reject the whole
 * report. A response that is not a JSON object at all, or that contains no
 * usable claim, is a provider failure — and that is what makes the router fall
 * back to the other provider.
 */
function buildReport(raw: unknown, payload: AiAnalysisInput): { report: AiReport; repairs: string[] } {
  const sanitized = sanitizeAiReport(raw, payload.evidence, payload);
  if (!sanitized) throw new AiError("malformed_response", "AI did not return a JSON report, so it was not used.");
  const repairs = [...sanitized.repair.notes];
  // An answer with no evidence claim at all is still a complete report (the
  // deterministic summary carries it), but the user is told how thin the AI
  // contribution was instead of being shown an unexplained empty section.
  if (reportIsEmpty(sanitized.report)) {
    repairs.push("The AI answer cited no evidence row, so this report is carried by your deterministic summary.");
  }
  return { report: sanitized.report, repairs };
}

type AnalysisExecution = {
  report: AiReport;
  repairs: string[];
  stats: AiRequestStats;
  mode: "single" | "chunked";
  schemaFallback: boolean;
};

/** Summarizes every context slice, with the same bounded retry policy. */
async function executeChunkSummary(input: {
  provider: AiProviderId;
  apiKey: string;
  model: string;
  chunks: AiRequestPlan["chunks"];
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: AiAnalysisProgress) => void;
}): Promise<AiChunkSummary[]> {
  const summaries: AiChunkSummary[] = [];
  for (const chunk of input.chunks) {
    input.onProgress?.({ phase: "chunk", index: chunk.index, total: chunk.total });
    const raw = await sendWithBackoff(input.provider, {
      apiKey: input.apiKey,
      model: input.model,
      system: ANALYSIS_CHUNK_SYSTEM_PROMPT,
      user: analysisChunkUserPrompt(chunk.payload),
      schemaName: ANALYSIS_CHUNK_SCHEMA_NAME,
      schema: ANALYSIS_CHUNK_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0.1,
      maxCompletionTokens: AI_TOKEN_POLICY.chunkOutputTokens,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    }, input.signal);
    const parsed = aiChunkSummarySchema.safeParse(raw);
    // A malformed slice must not silently vanish: it would let the synthesis
    // treat an unread context as a confirmed fact.
    if (!parsed.success) throw new AiError("schema_error", "A journal batch came back in an invalid shape, so this provider's analysis was stopped.");
    summaries.push(parsed.data);
  }
  return summaries;
}

/** Executes a plan: one request, or summarize-then-synthesize for large journals. */
async function executePlan(input: {
  provider: AiProviderId;
  plan: AiRequestPlan;
  model: string;
  apiKey: string;
  trades?: readonly CompactTrade[];
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: AiAnalysisProgress) => void;
}): Promise<AnalysisExecution> {
  const { provider, plan, model, apiKey, signal, onProgress } = input;
  let schemaFallback = false;
  const onSchemaFallback = () => { schemaFallback = true; };

  if (plan.mode === "single" && plan.payload) {
    onProgress?.({ phase: "preparing", index: 1, total: 1 });
    const payload = plan.payload;
    const raw = await sendWithBackoff(provider, {
      apiKey,
      model,
      system: ANALYSIS_SYSTEM_PROMPT,
      user: analysisUserPrompt(payload),
      schemaName: "gold_journal_analysis",
      schema: ANALYSIS_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0.1,
      maxCompletionTokens: plan.policy.maxOutputTokens,
      timeoutMs: input.timeoutMs,
      signal,
      onSchemaFallback,
    }, signal);
    const { report, repairs } = buildReport(raw, payload);
    return { report, repairs, stats: plan.stats, mode: "single", schemaFallback };
  }

  const summaries = await executeChunkSummary({ provider, apiKey, model, chunks: plan.chunks, timeoutMs: input.timeoutMs, signal, onProgress });
  onProgress?.({ phase: "synthesis", index: 1, total: 1 });
  const synthesis = buildSynthesisPayload({
    core: plan.core,
    summaries,
    ordered: plan.evidenceRows,
    trades: input.trades,
    maxEvidenceRows: plan.stats.evidenceRows,
    tradeLimit: 8,
    inputTokenBudget: plan.policy.maxInputTokens,
    outputTokenBudget: plan.policy.maxOutputTokens,
    model,
  });
  const raw = await sendWithBackoff(provider, {
    apiKey,
    model,
    system: ANALYSIS_SYSTEM_PROMPT,
    user: analysisUserPrompt(synthesis.payload),
    schemaName: "gold_journal_analysis",
    schema: ANALYSIS_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
    temperature: 0.1,
    maxCompletionTokens: plan.policy.maxOutputTokens,
    timeoutMs: input.timeoutMs,
    signal,
    onSchemaFallback,
  }, signal);
  const { report, repairs } = buildReport(raw, synthesis.payload);
  return { report, repairs, stats: synthesis.stats, mode: "chunked", schemaFallback };
}

/**
 * Runs one provider end to end, including the one-shot 413 re-plan.
 *
 * The transport has already adopted whatever allowance the provider stated (a
 * rate-limit header or the `Limit N` in a 413 body); if that did not already
 * shrink the budget, this steps it down. Either way the retry is sized strictly
 * below the refused request, rebuilt, and re-sent exactly once. A 413 is never
 * retried unchanged and never looped.
 */
async function runProvider(input: {
  provider: AiProviderId;
  apiKey: string;
  model: string;
  analysis: AnalysisResult;
  trades?: readonly CompactTrade[];
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: AiAnalysisProgress) => void;
}): Promise<{ execution: AnalysisExecution; reducedAfterTooLarge: boolean }> {
  const buildPlan = () => planAiRequest({
    analysis: input.analysis,
    trades: input.trades,
    model: input.model,
    allowanceTokens: getProviderRequestPolicy(input.provider, input.model).allowanceTokens,
  });
  const execute = (plan: AiRequestPlan) => executePlan({
    provider: input.provider,
    plan,
    model: input.model,
    apiKey: input.apiKey,
    trades: input.trades,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    onProgress: input.onProgress,
  });
  let plan = buildPlan();
  try {
    return { execution: await execute(plan), reducedAfterTooLarge: false };
  } catch (error) {
    if (!(error instanceof AiError) || error.code !== "request_too_large" || input.signal?.aborted) throw error;
    recordRefusedRequest(plan.policy.allowanceTokens);
    const smaller = buildPlan();
    const shrank = smaller.stats.estimatedInputTokens < plan.stats.estimatedInputTokens || smaller.chunks.length > 0;
    if (!shrank) throw error;
    plan = smaller;
    return { execution: await execute(plan), reducedAfterTooLarge: true };
  }
}

/** The report cache key: contract + provider set + requested model + dataset. */
function reportCacheKey(providers: AiProviderId[], requestedModel: string, analysis: AnalysisResult) {
  return [AI_SERVICE_VERSION, AI_REQUEST_VERSION, providers.join("+"), requestedModel, analysisDataFingerprint(analysis)].join(":");
}

/**
 * The deterministic report, built locally from the analysis engine alone. It
 * exists so an AI outage, an expired key, or a rate limit can never take the
 * report away from the user.
 */
function deterministicOutcome(input: {
  analysis: AnalysisResult;
  failures: AiProviderFailure[];
  cached?: boolean;
}): AiAnalysisOutcome {
  const report = buildDeterministicReport(input.analysis, buildEvidenceManifest(input.analysis));
  const detail = input.failures.map(item => `${providerLabel(item.provider)}: ${item.message}`).join(" ");
  const errorCode: AiErrorCode = input.failures.length === 1 ? input.failures[0].code : input.failures.length ? "all_providers_failed" : "not_configured";
  return {
    available: true,
    cached: input.cached ?? false,
    provider: null,
    model: null,
    report,
    deterministic: true,
    providerErrors: input.failures,
    errorCode,
    message: input.failures.length
      ? `No AI provider could produce a report, so the complete deterministic report is shown instead. ${detail}`.trim()
      : "AI is not configured, so the complete deterministic report is shown instead.",
  };
}

/**
 * Runs the evidence-bound performance review in the browser.
 *
 * Every configured provider is tried in fallback order and the first usable
 * report wins; if all of them fail, a complete deterministic report is returned
 * rather than nothing. Results are cached per service version + payload version +
 * provider set + requested model + dataset fingerprint, so re-clicking the same
 * dataset cannot re-spend tokens and a journal change can never reuse a stale
 * report. Failed AI responses are never cached as successes, and an identical
 * request already in flight is joined rather than duplicated.
 */
export async function analyzeJournal(input: {
  analysis: AnalysisResult;
  trades?: readonly CompactTrade[];
  feature?: AiFeature;
  signal?: AbortSignal;
  model?: string;
  timeoutMs?: number;
  onProgress?: (progress: AiAnalysisProgress) => void;
}): Promise<AiAnalysisOutcome> {
  const bundle: AiProviderBundle = readAiProviderBundle();
  const providers = configuredProviderIds(bundle);
  if (!providers.length) {
    return {
      available: false,
      cached: false,
      provider: null,
      model: null,
      report: null,
      message: "AI is not configured. Add a Google Gemini or Groq API key in Options; deterministic analysis remains available.",
      errorCode: "not_configured",
      modelRepairedFrom: null,
    };
  }

  const requestedModel = String(input.model ?? "").trim();
  const cacheKey = reportCacheKey(providers, requestedModel, input.analysis);
  removeExpiredCache();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.outcome, cached: true };

  // Deduplicate: a double-click, a StrictMode double-effect, or two surfaces
  // asking for the same thing must produce exactly one provider request.
  const dedupeKey = `${input.feature ?? "analysis"}:${cacheKey}`;
  const running = inFlight.get(dedupeKey);
  if (running) return { ...(await running), deduplicated: true };

  const task = (async (): Promise<AiAnalysisOutcome> => {
    const timeoutMs = resolveAiTimeoutMs(input.timeoutMs, MAX_AI_TIMEOUT_MS);
    const failures: AiProviderFailure[] = [];
    let repairedFrom: string | null = null;
    let availableModels: string[] | undefined;
    let warning: string | undefined;
    let schemaFallback = false;

    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index]!;
      if (input.signal?.aborted) return { ...failure(new AiError("cancelled", "AI request cancelled."), provider, null) };
      const settings = bundle.providers[provider]!;
      // An explicit `model` override belongs to the provider it was chosen for,
      // which is the first one tried. Every later provider uses its own saved
      // model, so a Gemini id can never be "repaired" into the Groq slot (or the
      // other way round) and silently rewrite the user's saved selection.
      const requested = (index === 0 ? requestedModel : "") || settings.model || defaultModelFor(provider);
      const resolution = await resolveModelForAnalysis({ provider, apiKey: settings.apiKey, requested, signal: input.signal });
      if (!resolution.ok) {
        failures.push({
          provider,
          code: resolution.error.code,
          message: resolution.error.code === "model_not_found" || resolution.error.code === "model_unsupported"
            ? `${resolution.error.message} Open AI settings to pick an available ${providerLabel(provider)} model.`
            : resolution.error.message,
        });
        continue;
      }
      const { model, repairedFrom: repair, available, warning: resolutionWarning } = resolution;
      if (repair) persistModelRepair(provider, model);
      if (resolutionWarning) warning = resolutionWarning;
      try {
        const { execution, reducedAfterTooLarge } = await runProvider({
          provider,
          apiKey: settings.apiKey,
          model,
          analysis: input.analysis,
          trades: input.trades,
          timeoutMs,
          signal: input.signal,
          onProgress: input.onProgress,
        });
        repairedFrom = repair;
        availableModels = available;
        schemaFallback = execution.schemaFallback;
        const outcome: AiAnalysisOutcome = {
          available: true,
          cached: false,
          provider,
          model,
          report: execution.report,
          repairs: execution.repairs.length ? execution.repairs : undefined,
          providerErrors: failures.length ? failures : undefined,
          schemaFallback: execution.schemaFallback || undefined,
          requestMode: execution.mode,
          reducedAfterTooLarge: reducedAfterTooLarge || undefined,
          requestStats: execution.stats,
          modelRepairedFrom: repairedFrom,
          availableModels,
          warning,
        };
        cache.set(cacheKey, { expiresAt: Date.now() + AI_CACHE_TTL_MS, outcome });
        return outcome;
      } catch (error) {
        if (input.signal?.aborted) return { ...failure(new AiError("cancelled", "AI request cancelled."), provider, model) };
        failures.push({
          provider,
          code: error instanceof AiError ? error.code : "provider_error",
          message: error instanceof Error ? error.message : `${providerLabel(provider)} failed.`,
        });
      }
    }

    // Every provider failed. The report must still be complete, so it is built
    // locally from the deterministic engine.
    return deterministicOutcome({ analysis: input.analysis, failures });
  })().finally(() => { if (inFlight.get(dedupeKey) === task) inFlight.delete(dedupeKey); });

  inFlight.set(dedupeKey, task);
  return task;
}

/** Removes one provider's stored credential (settings panel). */
export function removeProviderKey(provider: AiProviderId) {
  return clearProviderSettings(provider);
}

/** Stores one provider's credential (settings panel). */
export function saveProviderKey(provider: AiProviderId, input: { apiKey: string; model: string }) {
  const view = saveProviderSettings(provider, input);
  clearAiCache();
  return view;
}

/** True when the outcome could not use any AI provider. */
export function isDeterministicOutcome(outcome: AiAnalysisOutcome | null | undefined): boolean {
  return Boolean(outcome?.deterministic);
}

/** The active provider id, for settings copy. */
export function currentProviderId(): AiProviderId | null {
  return activeProviderId(readAiProviderBundle());
}

/** The provider order label, e.g. "Google Gemini → Groq". */
export function providerOrderLabel(): string {
  return getConfiguredProviders().map(providerLabel).join(" → ") || AI_PROVIDER_IDS.map(providerLabel).join(" → ");
}

/** Consistent, credential-free copy for each AI UI state. */
export const AI_UI_COPY: Record<AiUiState, { title: string; body: string }> = {
  not_configured: { title: "AI is not configured", body: "Add a Google Gemini or Groq API key in Options to enable AI. Deterministic analysis and journaling keep working without it." },
  ready: { title: "AI is ready", body: "Your keys are stored only in this browser and requests go straight to the provider." },
  analyzing: { title: "Analyzing…", body: "Waiting for the provider to return an evidence-bound response." },
  success: { title: "Analysis complete", body: "Review the evidence-bound report below." },
  invalid_key: { title: "The provider rejected this key", body: "Check the key in AI settings, then retry. The other provider is used automatically when it is configured." },
  unauthorized: { title: "This key is not authorized", body: "The key is valid but its project permissions do not allow this request. Check the key's permissions in the provider console." },
  model_not_found: { title: "The selected model is unavailable", body: "This model is no longer offered for your key. Open AI settings and choose an available model." },
  model_unsupported: { title: "The selected model cannot run this request", body: "Pick a chat model in AI settings, then retry." },
  model_unavailable: { title: "The selected model is temporarily unavailable", body: "Open AI settings and choose another model, then retry." },
  rate_limited: { title: "Rate limited", body: "The provider is throttling this key. Wait a moment and retry; the other provider is used automatically." },
  quota_exceeded: { title: "Provider quota reached", body: "This key's quota or billing limit is exhausted. Check the plan or wait for the limit window to reset." },
  request_too_large: { title: "This journal period is too large for one AI request", body: "Your selected journal period contains more data than one AI request may carry. Retry and the app will analyze it in smaller batches; the deterministic report is unaffected." },
  network_error: { title: "No connection to the AI provider", body: "Check your internet connection and retry. Your journal data is unaffected." },
  provider_error: { title: "The AI request failed", body: "The provider or the selected model failed. Retry, or choose a different model in AI settings." },
  timeout: { title: "AI timed out", body: "The request exceeded its time budget and was cancelled. Retry or pick a faster model." },
  cancelled: { title: "Cancelled", body: "The request was cancelled before completion. Deterministic analysis is unaffected." },
  invalid_request: { title: "The provider rejected the request", body: "The request shape was rejected. Retry, or choose a different model in AI settings." },
  schema_error: { title: "The AI answer was not usable", body: "The provider returned an answer that carried no usable evidence claim, so it was discarded and the complete deterministic report is shown instead." },
  blocked: { title: "The provider blocked the response", body: "The model refused this response. Adjust the journal data wording and retry; the deterministic report is unaffected." },
};
