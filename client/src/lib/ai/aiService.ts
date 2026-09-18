/**
 * The single browser AI service used by Analyze My Trade, the AI Mentor, AI
 * reports, and AI settings.
 *
 * The Risk Calculator is deliberately absent from this module: position sizing
 * is deterministic and broker-aware, and it must keep working when no key is
 * configured, Groq is unreachable, or the internet is offline.
 *
 * Provider: Groq — exclusively. This module is the one source of truth for Groq
 * configuration and exposes:
 *
 *   getAiSettings()              — the stored credential + model
 *   verifyGroqApiKey()           — live key + model status
 *   getAvailableGroqModels()     — models this key can actually call
 *   resolveCompatibleModel()     — verifies/repairs the selected model
 *   analyzeJournal()             — one budgeted, validated analysis request
 *
 * Request sizing and the 413 problem
 * ---------------------------------
 * Groq charges the prompt **plus** the reserved `max_completion_tokens` against
 * the model's per-minute token allowance and rejects an oversized request with
 * HTTP 413 before running inference. This service therefore never sends an
 * unmeasured payload:
 *
 *  1. `planAiRequest()` measures the whole request — dataset, system prompt and
 *     response schema — and shrinks only the dataset, down a fixed ladder, until
 *     the request fits the current allowance.
 *  2. Transient failures get a bounded exponential backoff (3 attempts).
 *  3. A 413 is never retried unchanged: the limit the provider stated is adopted,
 *     the payload is rebuilt strictly smaller, and only then is the request
 *     re-sent — once. If it still does not fit, the user is told to narrow the
 *     range.
 *
 * It never runs on a schedule, on page load, or on journal updates: only an
 * explicit user action starts a request, and an identical request already in
 * flight is joined rather than duplicated.
 */
import {
  AI_PROVIDER_ID,
  AI_SERVICE_VERSION,
  ANALYSIS_CHUNK_RESPONSE_SCHEMA,
  ANALYSIS_CHUNK_SCHEMA_NAME,
  ANALYSIS_CHUNK_SYSTEM_PROMPT,
  ANALYSIS_RESPONSE_SCHEMA,
  ANALYSIS_SYSTEM_PROMPT,
  DEFAULT_AI_MODEL,
  MAX_AI_TIMEOUT_MS,
  aiChunkSummarySchema,
  aiReportSchema,
  analysisChunkUserPrompt,
  analysisDataFingerprint,
  analysisUserPrompt,
  hasOnlyGroundedNumbers,
  normalizeGroqModelId,
  pickPreferredGroqModel,
  resolveAiTimeoutMs,
  stableHash16,
  validateEvidenceReport,
  type AiChunkSummary,
  type AiReport,
} from "@shared/aiCore";
import type { AnalysisResult } from "@shared/analysisEngine";
import {
  AI_REQUEST_VERSION,
  AI_TOKEN_POLICY,
  getAiRequestPolicy,
  recordRefusedRequest,
  resetWorkingTokenAllowance,
  type AiRequestStats,
} from "@shared/aiBudget";
import {
  buildSynthesisPayload,
  planAiRequest,
  type AiAnalysisInput,
  type AiCoreContext,
  type AiRequestPlan,
  type CompactTrade,
} from "@shared/aiPayload";
import { maskApiKey, purgeLegacyProviderSettings, readAiSettings, readAiSettingsView, subscribeAiSettings, updateAiModel } from "./aiStorage";
import { AiError, type AiErrorCode, type AiSettings, type AiSettingsView, type AiUiState } from "./aiTypes";
import { listGroqModels, requestGroqStructuredCompletion as sendGroqCompletion, type GroqModelInfo, type KeyVerification } from "./groqClient";

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

const cache = new Map<string, { expiresAt: number; outcome: AiAnalysisOutcome }>();
let modelCache: { key: string; expiresAt: number; models: GroqModelInfo[] } | null = null;
const inFlight = new Map<string, Promise<AiAnalysisOutcome>>();
let modelListInFlight: Promise<GroqModelInfo[]> | null = null;

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

/** Clears the learned token allowance so sizing returns to its conservative default. */
export function resetAiTokenBudget() {
  resetWorkingTokenAllowance();
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
 * digest, and concurrent callers share one request so a double-click cannot
 * issue two model listings.
 */
export async function getAvailableGroqModels(input: { apiKey?: string; force?: boolean; signal?: AbortSignal } = {}): Promise<GroqModelInfo[]> {
  const apiKey = input.apiKey?.trim() || getAiSettings()?.apiKey;
  if (!apiKey) throw new AiError("not_configured", "Add your Groq API key first.");
  const key = fingerprintKey(apiKey);
  if (!input.force && modelCache && modelCache.key === key && modelCache.expiresAt > Date.now()) return modelCache.models;
  if (modelListInFlight) return modelListInFlight;
  const pending = listGroqModels(apiKey, { signal: input.signal })
    .then(models => {
      modelCache = { key, expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models };
      return models;
    })
    .finally(() => { modelListInFlight = null; });
  modelListInFlight = pending;
  return pending;
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

const connectionInFlight = new Map<string, Promise<GroqConnectionStatus>>();

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
  const dedupeKey = `${fingerprintKey(apiKey)}:${requested}:${input.force ? "force" : "cached"}`;
  const existing = connectionInFlight.get(dedupeKey);
  if (existing) return existing;
  const pending = (async (): Promise<GroqConnectionStatus> => {
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
    } finally {
      connectionInFlight.delete(dedupeKey);
    }
  })();
  connectionInFlight.set(dedupeKey, pending);
  return pending;
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

/** Real Groq connection test: an actual request, never a key-shape check. */
export async function testAiConnection(input: { apiKey?: string; signal?: AbortSignal } = {}): Promise<KeyVerification> {
  return verifyGroqApiKey({ apiKey: input.apiKey, force: true, signal: input.signal });
}

/** Used by the settings panel to test a key before it is saved. */
export async function testGroqConnection(input: { apiKey?: string; model?: string | null; force?: boolean; signal?: AbortSignal } = {}): Promise<GroqConnectionStatus> {
  return checkGroqConnection({ ...input, force: input.force ?? true });
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
 * normalized here, and the payload size is the caller's responsibility: use
 * `planAiRequest()` so the request is measured against the token budget first.
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
async function sendWithBackoff(args: Parameters<typeof sendGroqCompletion>[0], signal?: AbortSignal): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_MAX_ATTEMPTS; attempt++) {
    try {
      return await sendGroqCompletion(args);
    } catch (error) {
      lastError = error;
      if (attempt >= TRANSIENT_MAX_ATTEMPTS || !isTransientFailure(error) || signal?.aborted) throw error;
      await delay(TRANSIENT_BASE_DELAY_MS * 3 ** (attempt - 1), signal);
    }
  }
  throw lastError;
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

/** Report cache key: contract + provider + payload version + model + dataset. */
function reportCacheKey(model: string, analysis: AnalysisResult) {
  return `${AI_SERVICE_VERSION}:${AI_PROVIDER_ID}:${AI_REQUEST_VERSION}:${model}:${analysisDataFingerprint(analysis)}`;
}

function validateReport(raw: unknown, payload: AiAnalysisInput): AiReport {
  const parsed = aiReportSchema.safeParse(raw);
  if (!parsed.success) throw new AiError("schema_error", "AI returned an invalid structured analysis, so it was rejected. Please retry.");
  if (!hasOnlyGroundedNumbers(parsed.data, payload)) throw new AiError("ungrounded_response", "AI returned an ungrounded numerical claim, so the report was rejected. Please retry.");
  if (!validateEvidenceReport(parsed.data, payload.evidence)) throw new AiError("ungrounded_response", "AI returned an evidence claim that does not match the supplied evidence, so the report was rejected. Please retry.");
  return parsed.data;
}

type AnalysisExecution = {
  report: AiReport;
  stats: AiRequestStats;
  mode: "single" | "chunked";
  schemaFallback: boolean;
};

/** Runs one request for a planned payload with the bounded retry policy. */
async function executeChunkSummary(input: {
  apiKey: string;
  model: string;
  core: AiCoreContext;
  chunks: AiRequestPlan["chunks"];
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: AiAnalysisProgress) => void;
}): Promise<AiChunkSummary[]> {
  const summaries: AiChunkSummary[] = [];
  for (const chunk of input.chunks) {
    input.onProgress?.({ phase: "chunk", index: chunk.index, total: chunk.total });
    const raw = await sendWithBackoff({
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
    if (!parsed.success) throw new AiError("schema_error", "A journal batch came back in an invalid shape, so the analysis was stopped. Please retry.");
    summaries.push(parsed.data);
  }
  return summaries;
}

/** Executes a plan: one request, or summarize-then-synthesize for large journals. */
async function executePlan(input: {
  plan: AiRequestPlan;
  model: string;
  apiKey: string;
  analysis: AnalysisResult;
  trades?: readonly CompactTrade[];
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: AiAnalysisProgress) => void;
}): Promise<AnalysisExecution> {
  const { plan, model, apiKey, signal, onProgress } = input;
  let schemaFallback = false;
  const onSchemaFallback = () => { schemaFallback = true; };

  if (plan.mode === "single" && plan.payload) {
    onProgress?.({ phase: "preparing", index: 1, total: 1 });
    const payload = plan.payload;
    const raw = await sendWithBackoff({
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
    return { report: validateReport(raw, payload), stats: plan.stats, mode: "single", schemaFallback };
  }

  const summaries = await executeChunkSummary({ apiKey, model, core: plan.core, chunks: plan.chunks, timeoutMs: input.timeoutMs, signal, onProgress });
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
  const raw = await sendWithBackoff({
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
  return { report: validateReport(raw, synthesis.payload), stats: synthesis.stats, mode: "chunked", schemaFallback };
}

/**
 * Runs the evidence-bound performance review in the browser.
 *
 * Results are cached per service version + provider + payload version + model +
 * dataset fingerprint, so re-clicking the same dataset cannot re-spend tokens and
 * a journal change can never reuse a stale report. Failed responses are never
 * cached, and an identical request already in flight is joined rather than
 * duplicated.
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

  const cacheKey = reportCacheKey(model, input.analysis);
  removeExpiredCache();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.outcome, cached: true };

  // Deduplicate: a double-click, a StrictMode double-effect, or two surfaces
  // asking for the same thing must produce exactly one provider request.
  const dedupeKey = `${input.feature ?? "analysis"}:${cacheKey}`;
  const running = inFlight.get(dedupeKey);
  if (running) return { ...(await running), deduplicated: true };

  const task = (async (): Promise<AiAnalysisOutcome> => {
    const decorate = (outcome: AiAnalysisOutcome): AiAnalysisOutcome => ({ ...outcome, modelRepairedFrom: repairedFrom, availableModels: available, warning });
    const timeoutMs = resolveAiTimeoutMs(input.timeoutMs, MAX_AI_TIMEOUT_MS);
    const buildPlan = () => planAiRequest({ analysis: input.analysis, trades: input.trades, model, allowanceTokens: getAiRequestPolicy(model).allowanceTokens });
    try {
      let plan = buildPlan();
      let execution: AnalysisExecution;
      let reducedAfterTooLarge = false;
      try {
        execution = await executePlan({ plan, model, apiKey: settings.apiKey, analysis: input.analysis, trades: input.trades, timeoutMs, signal: input.signal, onProgress: input.onProgress });
      } catch (error) {
        if (!(error instanceof AiError) || error.code !== "request_too_large" || input.signal?.aborted) throw error;
        // The request did not fit. The transport has already adopted whatever
        // allowance the provider stated (response header or 413 body); if that did
        // not already shrink the budget, this steps it down. Either way the next
        // attempt is sized strictly below the refused request, rebuilt, and re-sent
        // exactly once. A 413 is never retried unchanged.
        recordRefusedRequest(plan.policy.allowanceTokens);
        const smaller = buildPlan();
        const shrank = smaller.stats.estimatedInputTokens < plan.stats.estimatedInputTokens || smaller.chunks.length > 0;
        if (!shrank) throw error;
        plan = smaller;
        reducedAfterTooLarge = true;
        execution = await executePlan({ plan, model, apiKey: settings.apiKey, analysis: input.analysis, trades: input.trades, timeoutMs, signal: input.signal, onProgress: input.onProgress });
      }
      const outcome: AiAnalysisOutcome = decorate({
        available: true,
        cached: false,
        model,
        report: execution.report,
        schemaFallback: execution.schemaFallback,
        requestMode: execution.mode,
        reducedAfterTooLarge,
        requestStats: execution.stats,
      });
      cache.set(cacheKey, { expiresAt: Date.now() + AI_CACHE_TTL_MS, outcome });
      return outcome;
    } catch (error) {
      return decorate(failure(error, model));
    }
  })().finally(() => { if (inFlight.get(dedupeKey) === task) inFlight.delete(dedupeKey); });

  inFlight.set(dedupeKey, task);
  return task;
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
  request_too_large: { title: "This journal period is too large for one AI request", body: "Your selected journal period contains more data than one AI request may carry. Narrow the date range, or retry and the app will analyze it in smaller batches." },
  network_error: { title: "No connection to Groq", body: "Check your internet connection and retry. Your journal data is unaffected." },
  provider_error: { title: "Groq request failed", body: "Groq or the selected model failed. Retry, or choose a different model in AI settings." },
  timeout: { title: "AI timed out", body: "The request exceeded its time budget and was cancelled. Retry or pick a faster model." },
  cancelled: { title: "Cancelled", body: "The request was cancelled before completion." },
  invalid_request: { title: "Groq rejected the request", body: "The request shape was rejected. Retry, or choose a different Groq model in AI settings." },
  schema_error: { title: "AI report failed local validation", body: "The AI response was rejected by the local schema and evidence-grounding checks, so no report was produced and nothing was saved. Retry, or choose another Groq model." },
  blocked: { title: "Groq blocked the response", body: "The model refused this response. Adjust the journal data wording and retry." },
};
