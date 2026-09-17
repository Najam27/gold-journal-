/**
 * Groq transport that runs in the user's browser.
 *
 * The request goes straight from this browser to Groq's chat-completions API
 * over HTTPS. It is never proxied through Cloudflare, a Worker, a serverless
 * function, or any Gold Journal backend, and the API key is never placed in a
 * URL, a log line, or a telemetry payload: the `Authorization: Bearer` header
 * carries it on every call.
 *
 * Groq is the only provider in this application: this is the single transport
 * every AI feature shares.
 */
import { isStrictSchemaModel, normalizeGroqModelId, rankGroqModels, supportsReasoningEffort } from "@shared/aiCore";
import { AiError } from "./aiTypes";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_MODELS_URL = `${GROQ_BASE_URL}/models`;
export const GROQ_CHAT_COMPLETIONS_URL = `${GROQ_BASE_URL}/chat/completions`;

/** Anything that looks like a provider credential must never reach an error string. */
const KEY_LIKE = /(?:gsk_|sk-|AIza)[A-Za-z0-9_-]{8,}/g;

/**
 * Credential-free, human-useful excerpt of Groq's own error text. Without it a
 * 400 is undiagnosable; with it the user sees Groq's actual complaint.
 */
function sanitizeProviderMessage(message: string): string {
  return message.replace(KEY_LIKE, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 180);
}

const KEY_HINT = /api.?key|unauthorized|authentication|invalid.*token|bearer/i;
/**
 * Groq reports a missing, retired, or decommissioned model either as a machine
 * code (`model_not_found`, `model_decommissioned`, `model_not_available`) or in
 * prose, so both shapes are recognized. Dots are allowed inside the prose form
 * because Groq's own model ids contain them (`llama-3.3-70b-versatile`).
 */
const MODEL_MISSING_HINT = /model[_ ]?(?:not[_ ]?found|decommission|deprecat|not[_ ]?available)|no such model|model.{0,80}(?:does not exist|no longer|decommission|is not available|unknown model)/i;
const MODEL_UNSUPPORTED_HINT = /not supported|unsupported|does not support|don't support|only supports|not a chat model|requires a chat model/i;
const QUOTA_HINT = /quota|billing|spending limit|insufficient|credit|payment required|per day|daily limit|exceeded your current|upgrade/i;
const SCHEMA_HINT = /schema|response_format|json_schema|additionalproperties|constrained|invalid json payload|failed to parse/i;
const TOO_LARGE_HINT = /too large|reduce the length|context length|maximum context|token limit|too many tokens/i;

function isKeyRejection(status: number, providerMessage: string): boolean {
  if (status === 401) return true;
  if (status === 400 && KEY_HINT.test(providerMessage)) return true;
  return false;
}

/**
 * Maps a Groq HTTP status onto a stable internal error code so the UI can
 * explain *why* a request failed instead of showing a generic "provider error".
 */
function classifyStatus(status: number, providerMessage = ""): AiError {
  const detail = sanitizeProviderMessage(providerMessage);
  if (isKeyRejection(status, detail)) {
    return new AiError("invalid_key", "Groq rejected this API key. Check the key in AI settings.", status);
  }
  if (status === 403) {
    return QUOTA_HINT.test(detail)
      ? new AiError("quota_exceeded", "Groq refused this request because the project quota or billing limit is exhausted.", status)
      : new AiError("unauthorized", detail ? `Groq is not authorized for this request (HTTP 403): ${detail}` : "Groq is not authorized for this API key. Check the key's project permissions.", status);
  }
  if (status === 402) return new AiError("quota_exceeded", "Groq reports the account has no remaining credit. Add billing or wait for the free-tier window to reset.", status);
  if (status === 404) return new AiError("model_not_found", "The selected Groq model is unavailable for this API key. Choose an available model in AI settings.", status);
  if (status === 429) {
    return QUOTA_HINT.test(detail)
      ? new AiError("quota_exceeded", "Groq quota or rate limit reached for this key. Check your Groq plan or wait for the limit window to reset.", status)
      : new AiError("rate_limited", "Groq rate-limited this request. Wait a moment and retry.", status);
  }
  if (status >= 500) return new AiError("provider_error", "The Groq service is temporarily unavailable. Please retry.", status);
  if (status === 400 && MODEL_MISSING_HINT.test(detail)) {
    return new AiError("model_not_found", "The selected Groq model is no longer offered. Choose an available model in AI settings.", status);
  }
  if (status === 400 && MODEL_UNSUPPORTED_HINT.test(detail)) {
    return new AiError("model_unsupported", detail ? `The selected Groq model cannot run this request: ${detail}` : "The selected Groq model does not support this request. Choose another available model.", status);
  }
  if (status === 400 && SCHEMA_HINT.test(detail)) return new AiError("schema_error", `Groq rejected the requested response schema (HTTP 400): ${detail}`, status);
  if (status === 400 && TOO_LARGE_HINT.test(detail)) {
    return new AiError("invalid_request", "This journal dataset is larger than the selected Groq model's context window. Narrow the date range or choose a model with a larger context window.", status);
  }
  if (status === 400 || status === 422) {
    return new AiError("invalid_request", detail ? `Groq rejected the request (HTTP ${status}): ${detail}` : `Groq rejected the request shape (HTTP ${status}).`, status);
  }
  return new AiError("provider_error", detail ? `Groq rejected the request (HTTP ${status}): ${detail}` : `Groq rejected the request (HTTP ${status}). Check the selected model or retry.`, status);
}

function classifyThrown(error: unknown, timedOut: boolean, abortedByUser: boolean): AiError {
  if (abortedByUser) return new AiError("cancelled", "AI request cancelled.");
  if (timedOut) return new AiError("timeout", "AI request timed out. Please retry.");
  if (error instanceof AiError) return error;
  // `fetch` rejects with a TypeError on DNS/offline/CORS failures.
  return new AiError("network_error", "Could not reach Groq. Check your internet connection and retry.");
}

type RequestOptions = {
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

/**
 * Best-effort, credential-free provider error text from a Groq body. Groq's
 * machine `code` is included ahead of the prose message because it is the most
 * reliable classification signal (`invalid_api_key`, `model_not_found`, …).
 */
async function providerErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown; code?: unknown; type?: unknown } | string } | null;
    const raw = body?.error;
    if (typeof raw === "string") return raw.slice(0, 200);
    const parts = [raw?.code, raw?.message]
      .filter(part => typeof part === "string" && String(part).trim().length > 0)
      .map(part => String(part).trim());
    return parts.join(" · ").slice(0, 200);
  } catch {
    return "";
  }
}

function rethrowTransport(error: unknown, deadline: { flags: () => { timedOut: boolean; abortedByUser: boolean } }): never {
  const { timedOut, abortedByUser } = deadline.flags();
  if (error instanceof Error && error.name === "AbortError" && !timedOut && !abortedByUser) throw new AiError("network_error", "Could not reach Groq. Check your internet connection and retry.");
  throw classifyThrown(error, timedOut, abortedByUser);
}

/** A chat model entry that this specific key can actually run. */
export type GroqModelInfo = { id: string; label: string; contextWindow: number | null };

export type KeyVerification = {
  label: string;
  freeTier: boolean;
  limitRemaining: number | null;
  /** Groq model ids this key can actually call for chat completions. */
  models: string[];
};

/**
 * Turns Groq's `GET /models` listing into usable chat model ids so the settings UI
 * can offer models this specific key is actually allowed to call. Audio, speech,
 * guardrail, and embedding models share the same listing and are filtered out:
 * they cannot produce a journal report.
 */
export function normalizeModelList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; name?: unknown };
    const id = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : null;
    if (!id) continue;
    ids.push(id);
  }
  return rankGroqModels(ids);
}

/** Normalizes a Groq model listing page into picker-friendly entries. */
function toModelInfo(raw: unknown): GroqModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const models: GroqModelInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; name?: unknown; context_window?: unknown; contextWindow?: unknown; owned_by?: unknown };
    const rawId = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : null;
    const id = normalizeGroqModelId(rawId);
    if (!id) continue;
    const contextWindow = Number(record.context_window ?? record.contextWindow);
    models.push({
      id,
      label: typeof record.owned_by === "string" && record.owned_by.trim() ? `${id} · ${record.owned_by.trim()}` : id,
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
    });
  }
  return models;
}

/**
 * Lists every chat model this key can call. Groq returns the full hosted catalog
 * in one response, so a single request is enough.
 */
export async function listGroqModels(apiKey: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<GroqModelInfo[]> {
  const deadline = withDeadline({ signal: options.signal, timeoutMs: Math.min(30_000, options.timeoutMs ?? 30_000) });
  try {
    const response = await fetch(GROQ_MODELS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: deadline.signal,
    });
    if (!response.ok) throw classifyStatus(response.status, await providerErrorMessage(response));
    const body = (await response.json().catch(() => null)) as { data?: unknown; models?: unknown } | null;
    if (!body || typeof body !== "object") throw new AiError("malformed_response", "Groq returned an unreadable model list.");
    const byId = new Map(toModelInfo(body.data ?? body.models).map(model => [model.id, model]));
    return rankGroqModels(Array.from(byId.keys())).map(id => byId.get(id)!).filter(Boolean);
  } catch (error) {
    return rethrowTransport(error, deadline);
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
  maxCompletionTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called when Groq rejected the strict schema and the request was retried in JSON-object mode. */
  onSchemaFallback?: () => void;
};

/**
 * Groq's `strict: true` structured outputs require every object to set
 * `additionalProperties: false` and to list every property in `required`. The
 * shared schema already satisfies both, so this only deep-copies it — it never
 * invents fields or silently drops a constraint that the local validation
 * depends on.
 */
export function toGroqJsonSchema(node: unknown): Record<string, unknown> {
  if (Array.isArray(node)) return { items: toGroqJsonSchema(node[0] ?? {}) };
  if (!node || typeof node !== "object") return {};
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "properties" && value && typeof value === "object") {
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) properties[name] = toGroqJsonSchema(child);
      out.properties = properties;
      continue;
    }
    if (key === "items") {
      out.items = toGroqJsonSchema(value);
      continue;
    }
    out[key] = value;
  }
  if (out.properties && typeof out.properties === "object") {
    // Groq strict mode requires `required` to name every declared property.
    out.required = Object.keys(out.properties as Record<string, unknown>);
    out.additionalProperties = false;
  }
  return out;
}

type GroqChatResponse = {
  choices?: Array<{
    message?: { content?: unknown; refusal?: unknown; reasoning?: unknown };
    finish_reason?: string;
  }>;
  error?: { message?: unknown; code?: unknown } | string;
};

const TRUNCATED_FINISH_REASONS = new Set(["length", "max_tokens"]);

/** Parses a completion's text, tolerating a fenced JSON block. */
function parseCompletionJson(content: string): unknown {
  const text = content.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : text);
}

function completionText(body: GroqChatResponse): string | null {
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim().length > 0) return content;
  // Some models answer with structured content parts instead of one string.
  if (Array.isArray(content)) {
    const joined = content
      .map(part => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? String((part as { text?: unknown }).text) : ""))
      .join("");
    return joined.trim().length > 0 ? joined : null;
  }
  return null;
}

/**
 * Requests a structured chat completion from Groq and returns the parsed JSON
 * payload. The caller owns schema validation and grounding checks.
 *
 * Retry policy (deliberately tiny and explicit):
 *  - one downgrade retry when Groq rejects the strict schema/response_format
 *    shape (a request-shape problem, not a transient one);
 *  - nothing else. Invalid keys, unauthorized keys, missing models, oversized
 *    requests, and schema failures are surfaced immediately and never looped.
 */
export async function requestGroqStructuredCompletion(request: StructuredRequest): Promise<unknown> {
  const model = normalizeGroqModelId(request.model);
  if (!model) throw new AiError("model_not_found", "No Groq model is selected. Choose one in AI settings.");
  const deadline = withDeadline({ signal: request.signal, timeoutMs: request.timeoutMs ?? 120_000 });

  const buildBody = (withSchema: boolean, withReasoningEffort: boolean) => {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      temperature: request.temperature ?? 0.1,
      max_completion_tokens: request.maxCompletionTokens ?? 16_000,
      response_format:
        withSchema && isStrictSchemaModel(model)
          ? { type: "json_schema", json_schema: { name: request.schemaName, strict: true, schema: toGroqJsonSchema(request.schema) } }
          : { type: "json_object" },
    };
    // Reasoning models otherwise spend most of the completion budget thinking.
    if (withReasoningEffort && supportsReasoningEffort(model)) body.reasoning_effort = "low";
    return body;
  };

  const send = (withSchema: boolean, withReasoningEffort: boolean) =>
    fetch(GROQ_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${request.apiKey}`, Accept: "application/json" },
      signal: deadline.signal,
      body: JSON.stringify(buildBody(withSchema, withReasoningEffort)),
    });

  try {
    let response = await send(true, true);
    let providerMessage = "";
    if (!response.ok) {
      providerMessage = await providerErrorMessage(response);
      const detail = sanitizeProviderMessage(providerMessage);
      // A 400 on a strict structured request is almost always the response
      // schema or `reasoning_effort`, not the user's data. Groq's structured
      // outputs are model-dependent, so downgrade exactly once to
      // `json_object` — the browser-side zod + grounding validation still
      // enforces the full contract, so the result is exactly as safe.
      const canDowngrade =
        response.status === 400 &&
        !isKeyRejection(400, detail) &&
        !MODEL_MISSING_HINT.test(detail) &&
        !TOO_LARGE_HINT.test(detail);
      if (canDowngrade) {
        request.onSchemaFallback?.();
        response = await send(false, false);
        providerMessage = response.ok ? "" : await providerErrorMessage(response);
      }
      if (!response.ok) throw classifyStatus(response.status, providerMessage);
    }
    const body = (await response.json().catch(() => null)) as GroqChatResponse | null;
    if (!body || typeof body !== "object") throw new AiError("malformed_response", "Groq returned an empty response. Please retry.");
    const finishReason = body.choices?.[0]?.finish_reason;
    const refusal = body.choices?.[0]?.message?.refusal;
    if (typeof refusal === "string" && refusal.trim()) {
      throw new AiError("blocked", `Groq refused to answer (${refusal.trim().slice(0, 120)}). Adjust the journal data wording and retry.`);
    }
    const content = completionText(body);
    if (content == null) {
      if (finishReason && TRUNCATED_FINISH_REASONS.has(finishReason)) throw new AiError("schema_error", "Groq's report was cut off at the output limit. Retry, or choose a model with a larger output budget.");
      throw new AiError("malformed_response", "Groq returned an empty response. Please retry.");
    }
    if (finishReason && TRUNCATED_FINISH_REASONS.has(finishReason)) throw new AiError("schema_error", "Groq's report was cut off at the output limit. Retry, or choose a model with a larger output budget.");
    try {
      return parseCompletionJson(content);
    } catch {
      throw new AiError("malformed_response", "Groq returned an unreadable response. Please retry.");
    }
  } catch (error) {
    return rethrowTransport(error, deadline);
  } finally {
    deadline.cleanup();
  }
}
