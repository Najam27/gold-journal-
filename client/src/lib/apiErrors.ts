/**
 * Categorized API failures.
 *
 * A single opaque "The API request timed out" told the user nothing and told the
 * developer even less: it appeared for a slow database read, an expired session,
 * a missing account, a WebRequest failure, and a dead network alike. Every
 * client-visible failure is now classified into an actionable category, and each
 * failure is logged once with the request, the account, the duration, the HTTP
 * status, the server error code, and a correlation id. Secrets, API keys, and
 * response bodies are never logged.
 */

export type ApiErrorCategory =
  | "NETWORK_TIMEOUT"
  | "NETWORK_ERROR"
  | "AUTH_ERROR"
  | "ACCOUNT_NOT_FOUND"
  | "DATABASE_TIMEOUT"
  | "DATABASE_ERROR"
  | "MT5_NOT_CONNECTED"
  | "MT5_AUTH_ERROR"
  | "MT5_CONFIG_ERROR"
  | "MT5_HISTORY_ERROR"
  | "MT5_PAYLOAD_ERROR"
  | "SERVER_ERROR"
  | "PAYLOAD_ERROR";

export type ApiErrorCopy = { title: string; guidance: string; retryable: boolean };

export const API_ERROR_COPY: Record<ApiErrorCategory, ApiErrorCopy> = {
  NETWORK_TIMEOUT: {
    title: "The server did not answer in time",
    guidance: "The request was cancelled on the client after 15 seconds. Retry; if it repeats on the same view, the server read for that view is the slow part, not your connection.",
    retryable: true,
  },
  NETWORK_ERROR: {
    title: "The network connection failed",
    guidance: "Check your connection and retry. Your locally queued changes are safe and will sync when the connection returns.",
    retryable: true,
  },
  AUTH_ERROR: {
    title: "Your session is no longer valid",
    guidance: "Sign in again to continue. Nothing in this account was changed.",
    retryable: false,
  },
  ACCOUNT_NOT_FOUND: {
    title: "That trading account is unavailable",
    guidance: "The account was removed, renamed, or belongs to another user. Pick an account from the switcher and retry.",
    retryable: false,
  },
  DATABASE_TIMEOUT: {
    title: "The database read timed out",
    guidance: "The journal read did not finish in time. Retry; if it persists, the account has more history than the current query plan can serve promptly.",
    retryable: true,
  },
  DATABASE_ERROR: {
    title: "The database rejected the request",
    guidance: "This is a server-side data problem, not your input. Retry once, then report it with the correlation id below.",
    retryable: true,
  },
  MT5_NOT_CONNECTED: {
    title: "MT5 is not connected",
    guidance: "Attach the Gold Journal EA on a chart in that terminal, or check MT5 Live for the connection state.",
    retryable: true,
  },
  MT5_AUTH_ERROR: {
    title: "MT5 rejected the API key",
    guidance: "Issue (or replace) the key in MT5 Live, paste the new key into the EA inputs, and keep the EA attached.",
    retryable: false,
  },
  MT5_CONFIG_ERROR: {
    title: "MT5 is misconfigured",
    guidance: "Copy the exact HTTPS endpoint from MT5 Live into the EA's Endpoint input and allow it under Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL.",
    retryable: false,
  },
  MT5_HISTORY_ERROR: {
    title: "MT5 history could not be reconstructed",
    guidance: "The terminal is missing history for those positions. Open the symbols in MT5 so the terminal downloads their history, then retry.",
    retryable: true,
  },
  MT5_PAYLOAD_ERROR: {
    title: "MT5 sent a payload the server could not accept",
    guidance: "Re-download the current EA from MT5 Live so the payload version matches the deployed server.",
    retryable: false,
  },
  SERVER_ERROR: {
    title: "The server returned an error",
    guidance: "Retry once. If it repeats, report it with the correlation id below.",
    retryable: true,
  },
  PAYLOAD_ERROR: {
    title: "The server returned an unexpected response",
    guidance: "The response was not JSON, which normally means a proxy or deployment returned an error page. Retry, then reload the page.",
    retryable: true,
  },
};

export type ApiErrorFacts = ApiErrorCopy & { category: ApiErrorCategory; detail: string; status?: number; correlationId?: string };

type ErrorFacts = {
  message: string;
  name?: string;
  status?: number;
  code?: string;
};

function readErrorFacts(error: unknown): ErrorFacts {
  if (typeof error === "string") return { message: error };
  const value = (error ?? {}) as Record<string, any>;
  const data = value.data ?? value.shape?.data ?? {};
  const status = Number(value.status ?? value.statusCode ?? data.httpStatus ?? value.shape?.data?.httpStatus);
  const code = typeof data.code === "string" ? data.code : typeof value.code === "string" ? value.code : undefined;
  return {
    message: typeof value.message === "string" && value.message ? value.message : "The request failed.",
    name: typeof value.name === "string" ? value.name : undefined,
    status: Number.isFinite(status) && status > 0 ? status : undefined,
    code,
  };
}

export function apiErrorCategory(error: unknown): ApiErrorCategory | undefined {
  const category = (error as { category?: unknown } | null | undefined)?.category;
  return typeof category === "string" && category in API_ERROR_COPY ? (category as ApiErrorCategory) : undefined;
}

/** Attaches a category to an error (and to an apiErrorFacts payload already carried). */
export function tagApiError<T>(error: T, category?: ApiErrorCategory): T {
  if (!error || typeof error !== "object") return error;
  if (category && !(error as { category?: unknown }).category) (error as { category?: string }).category = category;
  return error;
}

/**
 * Classifies a failure without ever needing the response body, so nothing
 * sensitive can end up in a log line or in the UI.
 */
export function classifyApiError(error: unknown, context: { accountId?: number; surface?: string } = {}): ApiErrorFacts {
  const facts = readErrorFacts(error);
  const message = facts.message;
  const tagged = apiErrorCategory(error);
  const status = facts.status;
  const correlationId = (error as { correlationId?: string } | null | undefined)?.correlationId;
  const pick = (category: ApiErrorCategory): ApiErrorFacts => ({ ...API_ERROR_COPY[category], category, detail: message, status, correlationId });

  if (tagged) return pick(tagged);
  if (facts.code === "UNAUTHORIZED" || facts.code === "FORBIDDEN" || status === 401 || status === 403) return pick("AUTH_ERROR");
  if (facts.code === "TOO_MANY_REQUESTS" || status === 429) return pick("SERVER_ERROR");
  if (/timed out|timeout|aborted|TimeoutError/i.test(message)) return pick(/database|supabase|postgrest|aggregate|trade summary/i.test(message) ? "DATABASE_TIMEOUT" : "NETWORK_TIMEOUT");
  if (/unexpected non-JSON|not valid JSON|JSON/i.test(message)) return pick("PAYLOAD_ERROR");
  if (/trading account is unavailable|account is unavailable|ACCOUNT_NOT_FOUND|account belongs to another/i.test(message)) return pick("ACCOUNT_NOT_FOUND");
  if (/api key|AUTH_REVOKED|AUTH_ERROR|authentication/i.test(message) && /mt5/i.test(message)) return pick("MT5_AUTH_ERROR");
  if (/webrequest|endpoint|whitelist|CONFIG_ERROR/i.test(message) && /mt5|expert/i.test(message)) return pick("MT5_CONFIG_ERROR");
  if (/history (reconstruction|select|sync)/i.test(message)) return pick("MT5_HISTORY_ERROR");
  if (/payload version|unsupported payload|PAYLOAD/i.test(message)) return pick("MT5_PAYLOAD_ERROR");
  if (/mt5 is offline|mt5 offline|no active mt5 connection|mt5 not connected/i.test(message)) return pick("MT5_NOT_CONNECTED");
  if (/^mt5/i.test(context.surface ?? "") && /mt5/i.test(message)) return pick("MT5_NOT_CONNECTED");
  if (/supabase|postgrest|relation .* does not exist|migration/i.test(message)) return pick("DATABASE_ERROR");
  if (facts.code === "NOT_FOUND" && /account/i.test(message)) return pick("ACCOUNT_NOT_FOUND");
  if (facts.code === "BAD_REQUEST" || facts.code === "CONFLICT" || facts.code === "PRECONDITION_FAILED") return pick("DATABASE_ERROR");
  if ((status ?? 0) >= 500) return pick("SERVER_ERROR");
  if (/failed to fetch|networkerror|network error|load failed/i.test(message)) return pick("NETWORK_ERROR");
  return pick("SERVER_ERROR");
}

export function createCorrelationId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `gj-${Date.now().toString(36)}-${random}`;
}

/**
 * One structured line per failed request. Keys, tokens, and bodies never appear:
 * only the request path, the account, the duration, the status, and the
 * server-provided error code.
 */
export function logApiFailure(input: { request: string; correlationId: string; durationMs: number; error: unknown; accountId?: number; query?: string }) {
  const facts = readErrorFacts(input.error);
  const path = (() => {
    try { return new URL(input.request, "https://gold-journal.local").pathname; } catch { return "unknown"; }
  })();
  console.warn("[API]", JSON.stringify({
    correlationId: input.correlationId,
    request: path,
    query: input.query,
    accountId: input.accountId,
    durationMs: input.durationMs,
    status: facts.status,
    code: facts.code,
    category: apiErrorCategory(input.error) ?? classifyApiError(input.error).category,
    message: facts.message.slice(0, 240),
  }));
}
