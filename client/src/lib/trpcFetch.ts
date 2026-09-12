export const PREVIEW_API_UNAVAILABLE_MESSAGE = "The local preview API was temporarily unavailable. The preview server has been restarted; please retry the request.";
export const UNEXPECTED_API_RESPONSE_MESSAGE = "The API returned an unexpected non-JSON response. Please retry the request.";
export const API_REQUEST_TIMEOUT_MESSAGE = "The API request timed out. Check the deployment and network connection, then retry.";
export const API_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Every value in the tRPC surface is now a bounded backend read or write; AI
 * inference no longer runs server-side, so no route needs a long AI budget.
 */
export function trpcTimeoutMs(_input: RequestInfo | URL) {
  return API_REQUEST_TIMEOUT_MS;
}

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
      throw new Error(proxyUnavailable ? PREVIEW_API_UNAVAILABLE_MESSAGE : UNEXPECTED_API_RESPONSE_MESSAGE);
    }

    return response;
  } catch (error) {
    if (controller.signal.aborted && !sourceSignal?.aborted) throw new Error(API_REQUEST_TIMEOUT_MESSAGE);
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    sourceSignal?.removeEventListener("abort", forwardAbort);
  }
}
