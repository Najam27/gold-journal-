/**
 * Types for the browser-only AI layer.
 *
 * The Google AI Studio credential lives exclusively in this browser. Nothing in
 * this module is ever sent to the Gold Journal backend.
 */

export type AiErrorCode =
  | "not_configured"
  | "invalid_key"
  | "rate_limited"
  | "network_error"
  | "provider_error"
  | "timeout"
  | "cancelled"
  | "malformed_response"
  | "ungrounded_response";

/** Normalized failure thrown by the Google AI client and AI service. */
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
  | "rate_limited"
  | "network_error"
  | "provider_error"
  | "timeout"
  | "cancelled";

export function uiStateForErrorCode(code: AiErrorCode | null | undefined): AiUiState {
  switch (code) {
    case "not_configured": return "not_configured";
    case "invalid_key": return "invalid_key";
    case "rate_limited": return "rate_limited";
    case "network_error": return "network_error";
    case "timeout": return "timeout";
    case "cancelled": return "cancelled";
    case "malformed_response":
    case "ungrounded_response":
    default: return "provider_error";
  }
}

export function uiStateForError(error: unknown): AiUiState {
  return uiStateForErrorCode(error instanceof AiError ? error.code : "provider_error");
}
