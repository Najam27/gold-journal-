/**
 * Types for the browser-only AI layer.
 *
 * The Groq credential lives exclusively in this browser. Nothing in this module
 * is ever sent to the Gold Journal backend.
 */
import type { AiProviderId } from "@shared/aiCore";

/**
 * Stable internal error codes. Every provider HTTP status, network failure, and
 * local validation failure is normalized onto exactly one of these so the UI can
 * explain the real cause instead of a generic "provider error".
 */
export type AiErrorCode =
  | "not_configured"
  /** Every configured provider failed. A deterministic report is still shown. */
  | "all_providers_failed"
  | "invalid_key"
  | "unauthorized"
  | "model_not_found"
  | "model_unsupported"
  | "model_unavailable"
  | "rate_limited"
  | "quota_exceeded"
  | "request_too_large"
  | "network_error"
  | "timeout"
  | "cancelled"
  | "invalid_request"
  | "schema_error"
  | "blocked"
  | "provider_error"
  | "malformed_response"
  | "ungrounded_response";

/** Normalized failure thrown by the Groq client and AI service. */
export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status: number | null;
  constructor(code: AiErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.status = status;
  }
}

/** Human-readable, credential-free copy for every failure state. */
export function aiErrorMessage(error: unknown): string {
  if (error instanceof AiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "AI is temporarily unavailable. Please retry.";
}

/** Stored locally: the key never leaves this browser. */
export type AiSettings = { apiKey: string; model: string; updatedAt: number };

/** What the UI is allowed to know about one provider's stored credential. */
export type AiProviderSettingsView = {
  id: AiProviderId;
  configured: boolean;
  model: string | null;
  /** Masked identifier such as `gsk_••••••••abcd`. Never the full key. */
  maskedKey: string | null;
  updatedAt: number | null;
};

/** What the UI is allowed to know about the stored credentials. */
export type AiSettingsView = {
  configured: boolean;
  /** Active provider's model, or `null` when nothing is configured. */
  model: string | null;
  /** Masked identifier such as `gsk_••••••••abcd`. Never the full key. */
  maskedKey: string | null;
  updatedAt: number | null;
  /** True when this browser cannot persist settings (private mode etc.). */
  persistenceAvailable: boolean;
  /** Per-provider status for the settings panel. Masked only. */
  providers: AiProviderSettingsView[];
  /** Fallback order; the first configured provider is tried first. */
  priority: AiProviderId[];
  /** The provider whose key analysis currently uses, or `null`. */
  activeProvider: AiProviderId | null;
};

/** UI state machine for every AI surface. */
export type AiUiState =
  | "not_configured"
  | "ready"
  | "analyzing"
  | "success"
  | "invalid_key"
  | "unauthorized"
  | "model_not_found"
  | "model_unsupported"
  | "model_unavailable"
  | "rate_limited"
  | "quota_exceeded"
  | "request_too_large"
  | "network_error"
  | "provider_error"
  | "timeout"
  | "cancelled"
  | "invalid_request"
  | "schema_error"
  | "blocked";

export function uiStateForErrorCode(code: AiErrorCode | null | undefined): AiUiState {
  switch (code) {
    case "not_configured": return "not_configured";
    case "invalid_key": return "invalid_key";
    case "unauthorized": return "unauthorized";
    case "model_not_found": return "model_not_found";
    case "model_unsupported": return "model_unsupported";
    case "model_unavailable": return "model_unavailable";
    case "rate_limited": return "rate_limited";
    case "quota_exceeded": return "quota_exceeded";
    case "request_too_large": return "request_too_large";
    case "network_error": return "network_error";
    case "timeout": return "timeout";
    case "cancelled": return "cancelled";
    case "invalid_request": return "invalid_request";
    case "schema_error": return "schema_error";
    case "blocked": return "blocked";
    // Local validation rejections (bad JSON, schema mismatch, ungrounded
    // numbers) are distinct from a Groq outage: no report was produced, and
    // retrying or changing model is the fix.
    case "malformed_response":
    case "ungrounded_response": return "schema_error";
    case "all_providers_failed":
    case "provider_error":
    case null:
    case undefined:
    default: return "provider_error";
  }
}

export function uiStateForError(error: unknown): AiUiState {
  return uiStateForErrorCode(error instanceof AiError ? error.code : "provider_error");
}

/**
 * True when the failure can only be fixed by changing the configured model, so
 * the UI can offer the model picker instead of a pointless retry.
 */
export function isModelError(code: AiErrorCode | null | undefined): boolean {
  return code === "model_not_found" || code === "model_unsupported" || code === "model_unavailable";
}

/**
 * True when the fix is a smaller request rather than a different key or model,
 * so the UI offers "reduce the date range" instead of a pointless retry.
 */
export function isRequestSizeError(code: AiErrorCode | null | undefined): boolean {
  return code === "request_too_large";
}
