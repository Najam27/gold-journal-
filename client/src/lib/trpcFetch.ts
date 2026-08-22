export const PREVIEW_API_UNAVAILABLE_MESSAGE = "The local preview API was temporarily unavailable. The preview server has been restarted; please retry the request.";
export const UNEXPECTED_API_RESPONSE_MESSAGE = "The API returned an unexpected non-JSON response. Please retry the request.";
export const AI_UNEXPECTED_API_RESPONSE_MESSAGE = "The deployed AI service returned an invalid response. Confirm your key in Options; if it is connected, the hosting request may have ended before AI completed. Your journal data is unchanged.";
export const API_REQUEST_TIMEOUT_MESSAGE = "The API request timed out. Check the deployment and network connection, then retry.";
export const API_REQUEST_TIMEOUT_MS = 15_000;
export const AI_REQUEST_TIMEOUT_MS = 120_000;

export function trpcTimeoutMs(input: RequestInfo | URL) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return url.includes("/api/trpc/analysis.ai") || url.includes("/api/trpc/mt5.riskCoach") ? AI_REQUEST_TIMEOUT_MS : API_REQUEST_TIMEOUT_MS;
}
export function isAiTrpcRoute(input: RequestInfo | URL) { return trpcTimeoutMs(input) === AI_REQUEST_TIMEOUT_MS; }

export async function fetchTrpcResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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
      throw new Error(proxyUnavailable ? PREVIEW_API_UNAVAILABLE_MESSAGE : isAiTrpcRoute(input) ? AI_UNEXPECTED_API_RESPONSE_MESSAGE : UNEXPECTED_API_RESPONSE_MESSAGE);
    }

    return response;
  } catch (error) {
    if (controller.signal.aborted && !sourceSignal?.aborted) throw new Error(trpcTimeoutMs(input) === AI_REQUEST_TIMEOUT_MS ? "The AI request timed out after 2 minutes. Please retry; your journal data is unchanged." : API_REQUEST_TIMEOUT_MESSAGE);
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    sourceSignal?.removeEventListener("abort", forwardAbort);
  }
}
