/**
 * Types for the browser-only AI layer.
 *
 * The Google AI Studio (Gemini) credential lives exclusively in this browser.
 * Nothing in this module is ever sent to the Gold Journal backend.
 */

/**
 * Stable internal error codes. Every Gemini HTTP status, network failure, and
 * local validation failure is normalized onto exactly one of these so the UI
 * can explain the real cause instead of a generic "provider error".
 */
export type AiErrorCode =
  | "not_configured"
  | "invalid_key"
  | "model_not_found"
  | "model_unsupported"
  | "rate_limited"
  | "quota_exceeded"
  | "network_error"
  | "timeout"
  | "cancelled"
  | "invalid_request"
  | "schema_error"
  | "blocked"
  | "provider_error"
  | "malformed_response"
  | "ungrounded_response";

/** Normalized failure thrown by the Gemini client and AI service. */
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

/** What the UI is allowed to know about the stored credential. */
export type AiSettingsView = {
  configured: boolean;
  model: string | null;
  /** Masked identifier such as `AIzaSy••••••••abcd`. Never the full key. */
  maskedKey: string | null;
  updatedAt: number | null;
  /** True when this browser cannot persist settings (private mode etc.). */
  persistenceAvailable: boolean;
};

/** UI state machine for every AI surface. */
export type AiUiState =
  | "not_configured"
  | "ready"
  | "analyzing"
  | "success"
  | "invalid_key"
  | "model_not_found"
  | "model_unsupported"
  | "rate_limited"
  | "quota_exceeded"
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
    case "model_not_found": return "model_not_found";
    case "model_unsupported": return "model_unsupported";
    case "rate_limited": return "rate_limited";
    case "quota_exceeded": return "quota_exceeded";
    case "network_error": return "network_error";
    case "timeout": return "timeout";
    case "cancelled": return "cancelled";
    case "invalid_request": return "invalid_request";
    case "schema_error": return "schema_error";
    case "blocked": return "blocked";
    // Local validation rejections (bad JSON, schema mismatch, ungrounded
    // numbers) are distinct from a Gemini outage: no report was produced, and
    // retrying or changing model is the fix.
    case "malformed_response":
    case "ungrounded_response": return "schema_error";
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
  return code === "model_not_found" || code === "model_unsupported";
}
