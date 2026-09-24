/**
 * Google Gemini transport that runs in the user's browser.
 *
 * The request goes straight from this browser to the Gemini API over HTTPS. It
 * is never proxied through Cloudflare, a Worker, a serverless function, or any
 * Gold Journal backend, and the API key never appears in a URL, a log line, or a
 * telemetry payload: the `x-goog-api-key` header carries it on every call, which
 * is Google's documented alternative to the `?key=` query parameter.
 *
 * This is the second transport every AI feature shares. `groqClient` is the
 * other, and both expose the same normalized request/response contract so the
 * AI service can fall back from one to the other without knowing which one it is
 * talking to:
 *
 *   listModels(key)                          → the models this key may call
 *   requestStructuredCompletion({...})       → parsed JSON or a normalized AiError
 */
import { isUsableGeminiModelId, normalizeGeminiModelId, rankGeminiModels } from "@shared/aiCore";
import { AiError } from "./aiTypes";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_MODELS_URL = `${GEMINI_BASE_URL}/models?pageSize=200`;

/** `models/{model}:generateContent` — the model id is normalized and encoded. */
export function geminiGenerateUrl(model: string) {
  return `${GEMINI_BASE_URL}/models/${encodeURIComponent(normalizeGeminiModelId(model))}:generateContent`;
}

export const GEMINI_HEADERS = (apiKey: string) => ({ "Content-Type": "application/json", "x-goog-api-key": apiKey, Accept: "application/json" });

/** Credentials and internal identifiers must never reach a user-facing string. */
const KEY_LIKE = /(?:gsk_|sk-|AIza)[A-Za-z0-9_-]{8,}/g;

function sanitizeProviderMessage(message: string): string {
  return message.replace(KEY_LIKE, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 180);
}

const KEY_HINT = /api key not valid|api_key_invalid|invalid api key|api key expired|permission denied on resource|unauthenticated|consumer_invalid/i;
const QUOTA_HINT = /quota|billing|resource_exhausted|rate limit|exceeded your current/i;
const MODEL_MISSING_HINT = /not found|not supported for|is not supported|unknown model|does not exist|no longer available|deprecated/i;
const SCHEMA_HINT = /responseschema|response_schema|response schema|invalid json payload|unknown name|invalid argument/i;
const TOO_LARGE_HINT = /request payload size exceeds|too large|exceeds the maximum|input token|token count|context length|maximum context/i;

/**
 * Maps the Gemini API's `{ error: { code, status, message } }` onto a stable
 * internal error code so the UI explains the real cause and the AI service knows
 * whether falling back to the other provider is worthwhile.
 */
export function classifyGeminiError(status: number, statusText = "", providerMessage = ""): AiError {
  const detail = sanitizeProviderMessage(providerMessage);
  const machine = statusText.toUpperCase();
  if (status === 401 || (status === 400 && KEY_HINT.test(detail))) {
    return new AiError("invalid_key", "Google rejected this Gemini API key. Check the key in AI settings.", status);
  }
  if (status === 403) {
    return QUOTA_HINT.test(detail)
      ? new AiError("quota_exceeded", "Gemini refused this request because the project quota or billing limit is exhausted.", status)
      : new AiError("unauthorized", detail ? `Gemini is not authorized for this request (HTTP 403): ${detail}` : "Gemini is not authorized for this API key. Check the key's project and API enablement.", status);
  }
  if (status === 429 || machine === "RESOURCE_EXHAUSTED") {
    return QUOTA_HINT.test(detail) && /quota|billing|free tier/i.test(detail)
      ? new AiError("quota_exceeded", "Gemini quota reached for this key. Check your Google AI Studio plan or wait for the limit window to reset.", status)
      : new AiError("rate_limited", "Gemini rate-limited this request. Wait a moment and retry.", status);
  }
  if (status === 404 || machine === "NOT_FOUND") {
    return new AiError("model_not_found", "The selected Gemini model is unavailable for this API key. Choose an available model in AI settings.", status);
  }
  if (status === 413 || TOO_LARGE_HINT.test(detail)) {
    return new AiError("request_too_large", "This journal period holds more data than one Gemini request may carry. The app will retry with smaller batches.", status);
  }
  if (status === 400 && SCHEMA_HINT.test(detail) && !MODEL_MISSING_HINT.test(detail)) {
    return new AiError("schema_error", `Gemini rejected the requested response schema (HTTP 400): ${detail}`, status);
  }
  if (status === 400 && MODEL_MISSING_HINT.test(detail)) {
    return new AiError("model_not_found", "The selected Gemini model is no longer offered. Choose an available model in AI settings.", status);
  }
  if (status === 400) {
    return new AiError("invalid_request", detail ? `Gemini rejected the request (HTTP 400): ${detail}` : "Gemini rejected the request shape (HTTP 400).", status);
  }
  if (status >= 500) return new AiError("provider_error", "The Gemini service is temporarily unavailable. Please retry.", status);
  return new AiError("provider_error", detail ? `Gemini rejected the request (HTTP ${status}): ${detail}` : `Gemini rejected the request (HTTP ${status}).`, status);
}

function classifyThrown(error: unknown, timedOut: boolean, abortedByUser: boolean): AiError {
  if (abortedByUser) return new AiError("cancelled", "AI request cancelled.");
  if (timedOut) return new AiError("timeout", "AI request timed out. Please retry.");
  if (error instanceof AiError) return error;
  return new AiError("network_error", "Could not reach Google Gemini. Check your internet connection and retry.");
}

type RequestOptions = { signal?: AbortSignal; timeoutMs: number };

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

function rethrowTransport(error: unknown, deadline: { flags: () => { timedOut: boolean; abortedByUser: boolean } }): never {
  const { timedOut, abortedByUser } = deadline.flags();
  if (error instanceof Error && error.name === "AbortError" && !timedOut && !abortedByUser) throw new AiError("network_error", "Could not reach Google Gemini. Check your internet connection and retry.");
  throw classifyThrown(error, timedOut, abortedByUser);
}

/** Credential-free error text from a Gemini body, including its machine status. */
async function providerErrorDetail(response: Response): Promise<{ detail: string; statusText: string }> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown; status?: unknown } } | null;
    const message = typeof body?.error?.message === "string" ? body.error.message : "";
    const status = typeof body?.error?.status === "string" ? body.error.status : "";
    return { detail: [status, message].filter(Boolean).join(" · "), statusText: status };
  } catch {
    return { detail: "", statusText: "" };
  }
}

/* ------------------------------------------------------------------ *
 * Model discovery
 * ------------------------------------------------------------------ */

/** A Gemini model this specific key can actually run. */
export type GeminiModelInfo = { id: string; label: string; inputTokenLimit: number | null; outputTokenLimit: number | null };

/**
 * Gemini lists every model the key can see through `GET /v1beta/models`,
 * including embeddings and other non-generative models. Only entries that
 * advertise `generateContent` are kept, so the picker (and every automatic model
 * repair) can only ever offer a model that can produce a journal report.
 */
export function normalizeGeminiModelList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; supportedGenerationMethods?: unknown };
    const methods = Array.isArray(record.supportedGenerationMethods) ? record.supportedGenerationMethods.map(String) : [];
    // A listing that omits the field is accepted; one that names other methods
    // only is a model that cannot run `generateContent`.
    if (methods.length && !methods.includes("generateContent")) continue;
    if (typeof record.name === "string") ids.push(record.name.replace(/^models\//, ""));
  }
  return rankGeminiModels(ids);
}

function toModelInfo(raw: unknown): GeminiModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const models: GeminiModelInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; displayName?: unknown; inputTokenLimit?: unknown; outputTokenLimit?: unknown; supportedGenerationMethods?: unknown };
    const methods = Array.isArray(record.supportedGenerationMethods) ? record.supportedGenerationMethods.map(String) : [];
    if (methods.length && !methods.includes("generateContent")) continue;
    const id = normalizeGeminiModelId(typeof record.name === "string" ? record.name : "");
    if (!id || !isUsableGeminiModelId(id)) continue;
    const label = typeof record.displayName === "string" && record.displayName.trim() ? `${id} · ${record.displayName.trim()}` : id;
    const inputTokenLimit = Number(record.inputTokenLimit);
    const outputTokenLimit = Number(record.outputTokenLimit);
    models.push({
      id,
      label,
      inputTokenLimit: Number.isFinite(inputTokenLimit) && inputTokenLimit > 0 ? inputTokenLimit : null,
      outputTokenLimit: Number.isFinite(outputTokenLimit) && outputTokenLimit > 0 ? outputTokenLimit : null,
    });
  }
  const byId = new Map(models.map(model => [model.id, model]));
  return rankGeminiModels(Array.from(byId.keys())).map(id => byId.get(id)!).filter(Boolean);
}

/**
 * Lists every Gemini model this key can call. `ListModels` is paginated by
 * default, so `nextPageToken` is followed to completion — bounded to a handful
 * of pages because the catalog is small and an unbounded loop must never happen.
 */
export async function listGeminiModels(apiKey: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<GeminiModelInfo[]> {
  const deadline = withDeadline({ signal: options.signal, timeoutMs: Math.min(30_000, options.timeoutMs ?? 30_000) });
  const collected: GeminiModelInfo[] = [];
  try {
    let url: string | null = GEMINI_MODELS_URL;
    for (let page = 0; url && page < 5; page += 1) {
      const response = await fetch(url, { method: "GET", headers: GEMINI_HEADERS(apiKey), signal: deadline.signal });
      if (!response.ok) {
        const { detail, statusText } = await providerErrorDetail(response);
        throw classifyGeminiError(response.status, statusText, detail);
      }
      const body = (await response.json().catch(() => null)) as { models?: unknown; nextPageToken?: unknown } | null;
      if (!body || typeof body !== "object") throw new AiError("malformed_response", "Gemini returned an unreadable model list.");
      collected.push(...toModelInfo(body.models));
      url = typeof body.nextPageToken === "string" && body.nextPageToken ? `${GEMINI_MODELS_URL}&pageToken=${encodeURIComponent(body.nextPageToken)}` : null;
    }
    const byId = new Map(collected.map(model => [model.id, model]));
    return rankGeminiModels(Array.from(byId.keys())).map(id => byId.get(id)!).filter(Boolean);
  } catch (error) {
    return rethrowTransport(error, deadline);
  } finally {
    deadline.cleanup();
  }
}

/* ------------------------------------------------------------------ *
 * Structured output
 * ------------------------------------------------------------------ */

/**
 * Gemini accepts a JSON-schema subset through `generationConfig.responseSchema`
 * and **rejects** a request that carries any keyword outside that subset, so the
 * shared strict schema is projected onto the supported vocabulary rather than
 * sent verbatim:
 *
 *  - `$ref`/`$defs` are inlined (Gemini does not resolve references);
 *  - `additionalProperties` is dropped (unsupported; the local validator is what
 *    enforces closed objects);
 *  - `type: ["number", "null"]` becomes `type: "number", nullable: true`;
 *  - `pattern`, `minimum`, `maximum`, `maxLength`, `maxItems`, and friends are
 *    dropped — they are local validation concerns, and sending them is a 400.
 */
export function toGeminiJsonSchema(node: unknown, defs: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(node)) return { type: "array", items: toGeminiJsonSchema(node[0] ?? {}, defs) };
  if (!node || typeof node !== "object") return {};
  const source = node as Record<string, unknown>;

  const reference = typeof source.$ref === "string" ? source.$ref.replace(/^#\/\$defs\//, "") : null;
  if (reference && defs[reference]) return toGeminiJsonSchema(defs[reference], defs);
  if (source.$defs && typeof source.$defs === "object") defs = { ...defs, ...(source.$defs as Record<string, unknown>) };
  if (reference) return {};

  const out: Record<string, unknown> = {};
  const declared = source.type;
  if (Array.isArray(declared)) {
    const named = declared.map(String).filter(value => value !== "null");
    if (declared.includes("null")) out.nullable = true;
    if (named.length === 1) out.type = named[0];
    else if (named.length > 1) out.anyOf = named.map(value => ({ type: value }));
  } else if (typeof declared === "string") {
    out.type = declared;
  }
  if (typeof source.description === "string") out.description = source.description;
  if (Array.isArray(source.enum)) out.enum = source.enum.map(String);
  if (source.properties && typeof source.properties === "object") {
    const properties: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(source.properties as Record<string, unknown>)) properties[name] = toGeminiJsonSchema(child, defs);
    out.properties = properties;
    if (Array.isArray(source.required)) out.required = (source.required as unknown[]).map(String);
  }
  if (source.items) out.items = toGeminiJsonSchema(source.items, defs);
  // A schema node with no type at all is rejected by Gemini; an object with
  // properties is the only shape this app sends, so default it explicitly.
  if (!out.type && out.properties) out.type = "object";
  return out;
}

export type GeminiStructuredRequest = {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  /** Human label for diagnostics; Gemini has no schema-name field. */
  schemaName?: string;
  schema?: Record<string, unknown>;
  temperature?: number;
  maxCompletionTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called when Gemini rejected the response schema and JSON mode was used instead. */
  onSchemaFallback?: () => void;
};

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: unknown; status?: unknown };
};

/** Joins every text part of the first candidate into one JSON string. */
function candidateText(body: GeminiResponse): string | null {
  const parts = body.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const joined = parts.map(part => (part && typeof part.text === "string" ? part.text : "")).join("").trim();
  return joined.length ? joined : null;
}

function parseCompletionJson(content: string): unknown {
  const text = content.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : text);
}

/**
 * Requests a structured JSON answer from Gemini's `generateContent` and returns
 * the parsed payload. The caller owns schema validation and grounding checks.
 *
 * Retry policy mirrors the Groq transport and is deliberately tiny: exactly one
 * downgrade retry when Gemini rejects the `responseSchema` shape (a request-shape
 * problem), and nothing else. Invalid keys, quota, missing models, and a
 * truncated answer are surfaced immediately and never looped.
 */
export async function requestGeminiStructuredCompletion(request: GeminiStructuredRequest): Promise<unknown> {
  const model = normalizeGeminiModelId(request.model);
  if (!model) throw new AiError("model_not_found", "No Gemini model is selected. Choose one in AI settings.");
  const deadline = withDeadline({ signal: request.signal, timeoutMs: request.timeoutMs ?? 120_000 });

  const generationConfig = (withSchema: boolean): Record<string, unknown> => ({
    temperature: request.temperature ?? 0.1,
    maxOutputTokens: request.maxCompletionTokens ?? 16_000,
    responseMimeType: "application/json",
    ...(withSchema && request.schema ? { responseSchema: toGeminiJsonSchema(request.schema) } : {}),
  });

  const buildBody = (withSchema: boolean) => ({
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: "user", parts: [{ text: request.user }] }],
    generationConfig: generationConfig(withSchema),
  });

  const send = (withSchema: boolean) =>
    fetch(geminiGenerateUrl(model), {
      method: "POST",
      headers: GEMINI_HEADERS(request.apiKey),
      signal: deadline.signal,
      body: JSON.stringify(buildBody(withSchema)),
    });

  try {
    let response = await send(true);
    let { detail, statusText } = response.ok ? { detail: "", statusText: "" } : await providerErrorDetail(response);
    if (!response.ok) {
      const canDowngrade = response.status === 400 && SCHEMA_HINT.test(sanitizeProviderMessage(detail));
      if (canDowngrade) {
        request.onSchemaFallback?.();
        response = await send(false);
        if (!response.ok) ({ detail, statusText } = await providerErrorDetail(response));
      }
      if (!response.ok) throw classifyGeminiError(response.status, statusText, detail);
    }
    const body = (await response.json().catch(() => null)) as GeminiResponse | null;
    if (!body || typeof body !== "object") throw new AiError("malformed_response", "Gemini returned an empty response. Please retry.");
    const blockReason = body.promptFeedback?.blockReason;
    if (typeof blockReason === "string" && blockReason) {
      throw new AiError("blocked", `Gemini blocked this request (${sanitizeProviderMessage(blockReason)}). Adjust the journal data wording and retry.`);
    }
    const finishReason = body.candidates?.[0]?.finishReason;
    if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT" || finishReason === "BLOCKLIST") {
      throw new AiError("blocked", "Gemini refused this response. Adjust the journal data wording and retry.");
    }
    const content = candidateText(body);
    if (content == null) {
      if (finishReason === "MAX_TOKENS") throw new AiError("schema_error", "Gemini's report was cut off at the output limit. Retry, or choose a model with a larger output budget.");
      throw new AiError("malformed_response", "Gemini returned an empty response. Please retry.");
    }
    if (finishReason === "MAX_TOKENS") throw new AiError("schema_error", "Gemini's report was cut off at the output limit. Retry, or choose a model with a larger output budget.");
    try {
      return parseCompletionJson(content);
    } catch {
      throw new AiError("malformed_response", "Gemini returned an unreadable response. Please retry.");
    }
  } catch (error) {
    return rethrowTransport(error, deadline);
  } finally {
    deadline.cleanup();
  }
}
