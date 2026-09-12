/**
 * Minimal, dependency-free OpenRouter client that runs in the user's browser.
 *
 * The request goes straight from this browser to OpenRouter over HTTPS. It is
 * never proxied through Cloudflare, a Worker, a serverless function, or any
 * Gold Journal backend, and the API key is never placed in a URL, log line, or
 * telemetry payload.
 */
import { AiError } from "./aiTypes";

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OPENROUTER_APP_TITLE = "Gold Journal";

/**
 * Only plain metadata is sent in these optional attribution headers. The key
 * stays in the Authorization header, which is never a URL and never logged.
 */
function attributionHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "X-Title": OPENROUTER_APP_TITLE };
  if (typeof window !== "undefined" && window.location?.origin) headers["HTTP-Referer"] = window.location.origin;
  return headers;
}

function classifyStatus(status: number): AiError {
  if (status === 401 || status === 403) return new AiError("invalid_key", "OpenRouter rejected this API key. Check the key in AI settings.", status);
  if (status === 402) return new AiError("rate_limited", "OpenRouter reports insufficient credit for this key. Add credit or pick a cheaper model.", status);
  if (status === 429) return new AiError("rate_limited", "OpenRouter rate-limited this request. Wait a moment and retry.", status);
  if (status >= 500) return new AiError("provider_error", "The OpenRouter provider is temporarily unavailable. Please retry.", status);
  return new AiError("provider_error", `OpenRouter rejected the request (HTTP ${status}).`, status);
}

function classifyThrown(error: unknown, timedOut: boolean, abortedByUser: boolean): AiError {
  if (abortedByUser) return new AiError("cancelled", "AI request cancelled.");
  if (timedOut) return new AiError("timeout", "AI request timed out. Please retry.");
  if (error instanceof AiError) return error;
  // `fetch` rejects with a TypeError on DNS/offline/CORS failures.
  return new AiError("network_error", "Could not reach OpenRouter. Check your internet connection and retry.");
}

type RequestOptions = {
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs: number;
};

/** Combines the caller's cancel signal with the provider deadline. */
function withDeadline({ signal, timeoutMs }: RequestOptions) {
  const controller = new AbortController();
  let timedOut = false;
  let abortedByUser = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));
  const onAbort = () => {
    abortedByUser = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
    flags: () => ({ timedOut, abortedByUser }),
  };
}

export type KeyVerification = { label: string; freeTier: boolean; limitRemaining: number | null };

/** Validates a key against OpenRouter's own key endpoint. Key never persisted. */
export async function verifyOpenRouterKey(apiKey: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<KeyVerification> {
  const deadline = withDeadline({ apiKey, signal: options.signal, timeoutMs: Math.min(20_000, options.timeoutMs ?? 20_000) });
  try {
    const response = await fetch(OPENROUTER_KEY_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...attributionHeaders() },
      signal: deadline.signal,
    });
    if (!response.ok) throw classifyStatus(response.status);
    const body = (await response.json().catch(() => null)) as { data?: { label?: string; is_free_tier?: boolean; limit_remaining?: number | null } } | null;
    if (!body || typeof body !== "object") throw new AiError("malformed_response", "OpenRouter returned an unreadable key status.");
    return { label: body.data?.label?.slice(0, 40) || "OpenRouter key", freeTier: Boolean(body.data?.is_free_tier), limitRemaining: body.data?.limit_remaining ?? null };
  } catch (error) {
    const { timedOut, abortedByUser } = deadline.flags();
    if (error instanceof Error && error.name === "AbortError" && !timedOut && !abortedByUser) throw new AiError("network_error", "Could not reach OpenRouter. Check your internet connection and retry.");
    throw classifyThrown(error, timedOut, abortedByUser);
  } finally {
    deadline.cleanup();
  }
}

export type StructuredRequest = {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * Requests a strict structured completion and returns the parsed JSON payload.
 * The caller owns schema validation and grounding checks.
 */
export async function requestStructuredCompletion(request: StructuredRequest): Promise<unknown> {
  const deadline = withDeadline({ apiKey: request.apiKey, signal: request.signal, timeoutMs: request.timeoutMs ?? 120_000 });
  try {
    const response = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${request.apiKey}`, ...attributionHeaders() },
      signal: deadline.signal,
      body: JSON.stringify({
        model: request.model,
        temperature: request.temperature ?? 0.1,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        response_format: { type: "json_schema", json_schema: { name: request.schemaName, strict: true, schema: request.schema } },
      }),
    });
    if (!response.ok) throw classifyStatus(response.status);
    const body = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
    const content = body?.choices?.[0]?.message?.content;
    if (content == null) throw new AiError("malformed_response", "OpenRouter returned an empty response. Please retry.");
    let parsed: unknown;
    try {
      const text = String(content).trim();
      const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      parsed = JSON.parse(fenced ? fenced[1] : text);
    } catch {
      throw new AiError("malformed_response", "OpenRouter returned an unreadable response. Please retry.");
    }
    return parsed;
  } catch (error) {
    const { timedOut, abortedByUser } = deadline.flags();
    if (error instanceof Error && error.name === "AbortError" && !timedOut && !abortedByUser) throw new AiError("network_error", "Could not reach OpenRouter. Check your internet connection and retry.");
    throw classifyThrown(error, timedOut, abortedByUser);
  } finally {
    deadline.cleanup();
  }
}
