import { apiErrorCategory, classifyApiError, createCorrelationId, logApiFailure, tagApiError } from "./apiErrors";

export const PREVIEW_API_UNAVAILABLE_MESSAGE = "The local preview API was temporarily unavailable. The preview server has been restarted; please retry the request.";
export const UNEXPECTED_API_RESPONSE_MESSAGE = "The API returned an unexpected non-JSON response. Please retry the request.";
export const API_REQUEST_TIMEOUT_MESSAGE = "The API request timed out. Check the deployment and network connection, then retry.";
export const API_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Every value in the tRPC surface is now a bounded backend read or write; AI
 * inference no longer runs server-side, so no route needs a long AI budget.
 * The budget is NOT raised to hide slow reads: the read paths (journal.get and
 * trades.list) were made read-only and the MT5 reconciliation was taken off
 * them instead.
 */
export function trpcTimeoutMs(_input: RequestInfo | URL) {
  return API_REQUEST_TIMEOUT_MS;
}

export async function fetchTrpcResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const startedAt = Date.now();
  const correlationId = createCorrelationId();
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(new DOMException("API request timed out", "TimeoutError")), trpcTimeoutMs(input));
  const sourceSignal = init?.signal;
  const forwardAbort = () => controller.abort(sourceSignal?.reason);
  if (sourceSignal?.aborted) forwardAbort();
  else sourceSignal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const response = await globalThis.fetch(input, {
      ...(init ?? {}),
      credentials: "include",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const isJson = contentType.includes("application/json");

    if (!isJson) {
      const proxyUnavailable = response.headers.get("x-e2b-error-code") === "PROXY_SANDBOX_NOT_FOUND";
      throw tagApiError(
        Object.assign(new Error(proxyUnavailable ? PREVIEW_API_UNAVAILABLE_MESSAGE : UNEXPECTED_API_RESPONSE_MESSAGE), { correlationId }),
        proxyUnavailable ? "SERVER_ERROR" : "PAYLOAD_ERROR"
      );
    }

    return response;
  } catch (error) {
    // An intentional cancellation (account switch, unmounted view, superseded
    // query) is not a failure and must never be logged or surfaced as one.
    if (sourceSignal?.aborted) throw error;
    const timedOut = controller.signal.aborted;
    const failure = timedOut
      ? tagApiError(Object.assign(new Error(API_REQUEST_TIMEOUT_MESSAGE), { correlationId }), "NETWORK_TIMEOUT")
      : tagApiError(error, apiErrorCategory(error) ?? classifyApiError(error).category);
    if (failure && typeof failure === "object") Object.assign(failure as Record<string, unknown>, { correlationId });
    logApiFailure({ request: String(input), correlationId, durationMs: Date.now() - startedAt, error: failure });
    throw failure;
  } finally {
    globalThis.clearTimeout(timeout);
    sourceSignal?.removeEventListener("abort", forwardAbort);
  }
}
