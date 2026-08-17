export const PREVIEW_API_UNAVAILABLE_MESSAGE = "The local preview API was temporarily unavailable. The preview server has been restarted; please retry the request.";
export const UNEXPECTED_API_RESPONSE_MESSAGE = "The API returned an unexpected non-JSON response. Please retry the request.";

export async function fetchTrpcResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await globalThis.fetch(input, {
    ...(init ?? {}),
    credentials: "include",
  });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const isJson = contentType.includes("application/json");

  if (!isJson) {
    const proxyUnavailable = response.headers.get("x-e2b-error-code") === "PROXY_SANDBOX_NOT_FOUND" || response.status === 502;
    throw new Error(proxyUnavailable ? PREVIEW_API_UNAVAILABLE_MESSAGE : UNEXPECTED_API_RESPONSE_MESSAGE);
  }

  return response;
}
