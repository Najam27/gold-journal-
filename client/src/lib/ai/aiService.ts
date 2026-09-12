/**
 * The single browser AI service used by Analyze My Trade, AI Mentor, and Risk
 * Coach. All three callers share one OpenRouter implementation so there is
 * exactly one place that knows how to reach the provider.
 *
 * Every call:
 *  1. reads the credential from local browser storage,
 *  2. calls OpenRouter directly over HTTPS,
 *  3. validates the structured response against the shared schema and grounding
 *     rules, and
 *  4. returns a normalized outcome the UI can render.
 *
 * It never runs on a schedule, on page load, or on journal updates: only an
 * explicit user action starts a request.
 */
import {
  ANALYSIS_RESPONSE_SCHEMA,
  ANALYSIS_SYSTEM_PROMPT,
  MAX_AI_TIMEOUT_MS,
  RISK_COACH_RESPONSE_SCHEMA,
  RISK_COACH_SYSTEM_PROMPT,
  aiReportSchema,
  analysisDataFingerprint,
  analysisUserPrompt,
  buildAnalysisPromptPayload,
  buildEvidenceManifest,
  buildRiskCoachPayload,
  hasOnlyGroundedNumbers,
  isSafeRiskCoachReview,
  resolveAiTimeoutMs,
  riskCoachSchema,
  riskCoachUserPrompt,
  validateEvidenceReport,
  type AiReport,
  type RiskCoachReview,
} from "@shared/aiCore";
import type { AnalysisResult } from "@shared/analysisEngine";
import type { RiskCalculation } from "@shared/riskCalculator";
import { readAiSettings, readAiSettingsView } from "./aiStorage";
import { AiError, type AiErrorCode, type AiSettingsView, type AiUiState } from "./aiTypes";
import { requestStructuredCompletion, verifyOpenRouterKey, type KeyVerification } from "./openrouterClient";

const AI_CACHE_TTL_MS = 15 * 60_000;
const AI_CACHE_MAX = 64;
const cache = new Map<string, { expiresAt: number; outcome: AiAnalysisOutcome }>();

/** Legacy-compatible outcome shape so existing report renderers stay valid. */
export type AiAnalysisOutcome = {
  available: boolean;
  cached: boolean;
  model: string | null;
  report: AiReport | null;
  message?: string;
  errorCode?: AiErrorCode;
};

export type AiRiskCoachOutcome = {
  available: boolean;
  coach: RiskCoachReview | null;
  model: string | null;
  message?: string;
  errorCode?: AiErrorCode;
};

export function aiSettingsStatus(): AiSettingsView {
  return readAiSettingsView();
}

export function isAiConfigured(): boolean {
  return readAiSettings() !== null;
}

export function clearAiCache() {
  cache.clear();
}

function removeExpiredCache() {
  const now = Date.now();
  for (const [key, value] of Array.from(cache.entries())) if (value.expiresAt <= now) cache.delete(key);
  while (cache.size > AI_CACHE_MAX) cache.delete(cache.keys().next().value!);
}

function failure(error: unknown, model: string | null): AiAnalysisOutcome {
  const code = error instanceof AiError ? error.code : "provider_error";
  return { available: false, cached: false, model, report: null, message: error instanceof Error ? error.message : "AI is temporarily unavailable.", errorCode: code };
}

export async function testAiConnection(input: { apiKey?: string; signal?: AbortSignal } = {}): Promise<KeyVerification> {
  const key = input.apiKey?.trim() || readAiSettings()?.apiKey;
  if (!key) throw new AiError("not_configured", "Add your OpenRouter API key first.");
  return verifyOpenRouterKey(key, { signal: input.signal });
}

/**
 * Runs the evidence-bound performance review in the browser.
 *
 * Results are cached for fifteen minutes per model + dataset fingerprint so a
 * user cannot accidentally re-spend tokens by re-clicking the same dataset.
 */
export async function analyzeJournal(input: { analysis: AnalysisResult; signal?: AbortSignal; model?: string; timeoutMs?: number }): Promise<AiAnalysisOutcome> {
  const settings = readAiSettings();
  if (!settings) return { available: false, cached: false, model: null, report: null, message: "AI is not configured. Add your own OpenRouter key in Options; deterministic analysis remains available.", errorCode: "not_configured" };
  const model = (input.model ?? settings.model).trim() || settings.model;

  removeExpiredCache();
  const cacheKey = `${model}:${analysisDataFingerprint(input.analysis)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.outcome, cached: true };

  const manifest = buildEvidenceManifest(input.analysis);
  const payload = buildAnalysisPromptPayload(input.analysis);
  try {
    const raw = await requestStructuredCompletion({
      apiKey: settings.apiKey,
      model,
      system: ANALYSIS_SYSTEM_PROMPT,
      user: analysisUserPrompt(payload),
      schemaName: "gold_journal_analysis",
      schema: ANALYSIS_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0.1,
      timeoutMs: resolveAiTimeoutMs(input.timeoutMs, MAX_AI_TIMEOUT_MS),
      signal: input.signal,
    });
    const parsed = aiReportSchema.safeParse(raw);
    if (!parsed.success) throw new AiError("malformed_response", "OpenRouter returned an invalid structured analysis. Please retry.");
    if (!hasOnlyGroundedNumbers(parsed.data, payload)) throw new AiError("ungrounded_response", "OpenRouter returned an ungrounded numerical claim, so the report was rejected. Please retry.");
    if (!validateEvidenceReport(parsed.data, manifest)) throw new AiError("ungrounded_response", "OpenRouter returned an evidence claim that does not match the supplied evidence, so the report was rejected. Please retry.");
    const outcome: AiAnalysisOutcome = { available: true, cached: false, model, report: parsed.data };
    cache.set(cacheKey, { expiresAt: Date.now() + AI_CACHE_TTL_MS, outcome });
    return outcome;
  } catch (error) {
    return failure(error, model);
  }
}

/** Risk-process review over the deterministic calculator output. */
export async function coachRisk(input: { calculation: RiskCalculation; signal?: AbortSignal; model?: string; timeoutMs?: number }): Promise<AiRiskCoachOutcome> {
  const settings = readAiSettings();
  if (!settings) return { available: false, coach: null, model: null, message: "AI Risk Coach is not configured. Add your own OpenRouter key in Options; the deterministic calculation remains available.", errorCode: "not_configured" };
  const model = (input.model ?? settings.model).trim() || settings.model;
  try {
    const raw = await requestStructuredCompletion({
      apiKey: settings.apiKey,
      model,
      system: RISK_COACH_SYSTEM_PROMPT,
      user: riskCoachUserPrompt(buildRiskCoachPayload(input.calculation)),
      schemaName: "gold_journal_risk_coach",
      schema: RISK_COACH_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0,
      timeoutMs: resolveAiTimeoutMs(input.timeoutMs, MAX_AI_TIMEOUT_MS),
      signal: input.signal,
    });
    const parsed = riskCoachSchema.safeParse(raw);
    if (!parsed.success) throw new AiError("malformed_response", "OpenRouter returned an invalid risk review. Please retry.");
    if (!isSafeRiskCoachReview(parsed.data)) throw new AiError("ungrounded_response", "The risk review contained trading instructions, so it was rejected. Please retry.");
    return { available: true, coach: parsed.data, model };
  } catch (error) {
    const code = error instanceof AiError ? error.code : "provider_error";
    return { available: false, coach: null, model, message: error instanceof Error ? error.message : "AI Risk Coach is temporarily unavailable.", errorCode: code };
  }
}

/** Consistent, credential-free copy for each AI UI state. */
export const AI_UI_COPY: Record<AiUiState, { title: string; body: string }> = {
  not_configured: { title: "AI is not configured", body: "Add your own OpenRouter API key in Options to enable AI. Deterministic analysis and journaling keep working without it." },
  ready: { title: "AI is ready", body: "Your key is stored only in this browser and requests go straight to OpenRouter." },
  analyzing: { title: "Analyzing…", body: "Waiting for OpenRouter to return an evidence-bound response." },
  success: { title: "Analysis complete", body: "Review the evidence-bound report below." },
  invalid_key: { title: "OpenRouter rejected this key", body: "Check the API key in AI settings, then retry." },
  rate_limited: { title: "Rate limited", body: "OpenRouter is throttling this key or it needs credit. Wait a moment and retry." },
  network_error: { title: "No connection to OpenRouter", body: "Check your internet connection and retry. Your journal data is unaffected." },
  provider_error: { title: "Provider error", body: "OpenRouter or the selected model failed. Retry, or choose a different model." },
  timeout: { title: "AI timed out", body: "The request exceeded its time budget and was cancelled. Retry or pick a faster model." },
  cancelled: { title: "Cancelled", body: "The request was cancelled before completion." },
};
