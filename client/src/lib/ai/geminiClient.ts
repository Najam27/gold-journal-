/**
 * Google AI Studio (Gemini) transport that runs in the user's browser.
 *
 * The request goes straight from this browser to Google's Generative Language
 * API over HTTPS. It is never proxied through Cloudflare, a Worker, a
 * serverless function, or any Gold Journal backend, and the API key is never
 * placed in a URL, log line, or telemetry payload: the `x-goog-api-key` header
 * carries it on every call.
 */
import { normalizeGeminiModelId, rankGeminiModels } from "@shared/aiCore";
import { AiError } from "./aiTypes";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_MODELS_URL = `${GEMINI_BASE_URL}/models`;

/** One listing page. Google caps a page at 1000 entries; 200 keeps it to one round trip for most keys. */
const MODELS_PAGE_SIZE = 200;
const MODELS_MAX_PAGES = 5;

function modelsPageUrl(pageToken?: string): string {
  const params = new URLSearchParams({ pageSize: String(MODELS_PAGE_SIZE) });
  if (pageToken) params.set("pageToken", pageToken);
  return `${GEMINI_MODELS_URL}?${params.toString()}`;
}

/** Anything that looks like a provider credential must never reach an error string. */
const KEY_LIKE = /(?:AIza|sk-)[A-Za-z0-9_-]{8,}/g;

/**
 * Credential-free, human-useful excerpt of Google's own error text. Without it a
 * 400 is undiagnosable; with it the user sees Google's actual complaint.
 */
function sanitizeProviderMessage(message: string): string {
  return message.replace(KEY_LIKE, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 180);
}

const MODEL_NOT_FOUND_HINT = /not found|not exist|no such model|unknown model|is not available|isn't available|invalid model/i;
const MODEL_UNSUPPORTED_HINT = /not supported|unsupported|does not support|don't support|supported generation methods|not available for|only supports/i;
const QUOTA_HINT = /quota|billing|spending limit|free tier|credit|resource_exhausted|per day|daily limit|exceeded your current/i;
const SCHEMA_HINT = /response_?schema|responseSchema|invalid json payload|unknown name|schema/i;

function isKeyRejection(status: number, providerMessage: string): boolean {
  if (status === 401) return true;
  if (status === 400 && /api.?key/i.test(providerMessage)) return true;
  if (status === 403) return !QUOTA_HINT.test(providerMessage);
  return false;
}

/**
 * Maps a Gemini HTTP status onto a stable internal error code so the UI can
 * explain *why* a request failed instead of showing a generic "provider error".
 */
function classifyStatus(status: number, providerMessage = ""): AiError {
  const detail = sanitizeProviderMessage(providerMessage);
  if (isKeyRejection(status, detail)) return new AiError("invalid_key", "Gemini rejected this API key. Check the key in AI settings.", status);
  if (status === 400 && MODEL_NOT_FOUND_HINT.test(detail)) return new AiError("model_not_found", "The selected Gemini model is no longer offered. Choose an available model in AI settings.", status);
  if (status === 404) return new AiError("model_not_found", "The selected Gemini model is unavailable for this API key. Choose an available model in AI settings.", status);
  if (status === 400 && MODEL_UNSUPPORTED_HINT.test(detail)) return new AiError("model_unsupported", "The selected Gemini model does not support generateContent. Choose another available model.", status);
  if (status === 429) {
    return QUOTA_HINT.test(detail)
      ? new AiError("quota_exceeded", "Gemini quota or billing limit reached for this key. Check your Google AI Studio plan or wait for the quota window to reset.", status)
      : new AiError("rate_limited", "Gemini rate-limited this request. Wait a moment and retry.", status);
  }
  if (status === 403) return new AiError("quota_exceeded", detail ? `Gemini refused the request (HTTP 403): ${detail}` : "Gemini refused this API key or its project quota is exhausted.", status);
  if (status >= 500) return new AiError("provider_error", "The Gemini service is temporarily unavailable. Please retry.", status);
  if (status === 400 && SCHEMA_HINT.test(detail)) return new AiError("schema_error", `Gemini rejected the requested response schema (HTTP 400): ${detail}`, status);
  if (status === 400) return new AiError("invalid_request", detail ? `Gemini rejected the request (HTTP 400): ${detail}` : "Gemini rejected the request shape (HTTP 400).", status);
  return new AiError("provider_error", detail ? `Gemini rejected the request (HTTP ${status}): ${detail}` : `Gemini rejected the request (HTTP ${status}). Check the selected model or retry.`, status);
}

function classifyThrown(error: unknown, timedOut: boolean, abortedByUser: boolean): AiError {
  if (abortedByUser) return new AiError("cancelled", "AI request cancelled.");
  if (timedOut) return new AiError("timeout", "AI request timed out. Please retry.");
  if (error instanceof AiError) return error;
  // `fetch` rejects with a TypeError on DNS/offline/CORS failures.
  return new AiError("network_error", "Could not reach Gemini. Check your internet connection and retry.");
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

/** Best-effort, credential-free provider error message from a Gemini body. */
async function providerErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } } | null;
    const message = typeof body?.error?.message === "string" ? body.error.message : "";
    return message.slice(0, 200);
  } catch {
    return "";
  }
}

function rethrowTransport(error: unknown, deadline: { flags: () => { timedOut: boolean; abortedByUser: boolean } }): never {
  const { timedOut, abortedByUser } = deadline.flags();
  if (error instanceof Error && error.name === "AbortError" && !timedOut && !abortedByUser) throw new AiError("network_error", "Could not reach Gemini. Check your internet connection and retry.");
  throw classifyThrown(error, timedOut, abortedByUser);
}

/** A model entry that this specific key can actually run inference on. */
export type GeminiModelInfo = { id: string; label: string; inputTokenLimit: number | null };

export type KeyVerification = {
  label: string;
  freeTier: boolean;
  limitRemaining: number | null;
  /** Gemini model ids this key can actually call for text generation. */
  models: string[];
};

/**
 * Turns Google's model listing into usable `generateContent` model ids so the
 * settings UI can offer models this specific key is actually allowed to call.
 * Only text-generation models survive: image, speech, audio, video, and
 * embedding models also answer `generateContent` but cannot produce a report.
 */
export function normalizeModelList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; supportedGenerationMethods?: unknown };
    if (typeof record.name !== "string") continue;
    const methods = Array.isArray(record.supportedGenerationMethods) ? record.supportedGenerationMethods : [];
    if (!methods.includes("generateContent")) continue;
    ids.push(record.name);
  }
  return rankGeminiModels(ids);
}

/** Normalizes a raw page of Google models into picker-friendly entries. */
function toModelInfo(raw: unknown): GeminiModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const models: GeminiModelInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown; inputTokenLimit?: unknown };
    if (typeof record.name !== "string") continue;
    const methods = Array.isArray(record.supportedGenerationMethods) ? record.supportedGenerationMethods : [];
    if (!methods.includes("generateContent")) continue;
    const id = normalizeGeminiModelId(record.name);
    if (!id) continue;
    models.push({
      id,
      label: typeof record.displayName === "string" && record.displayName.trim() ? record.displayName.trim() : id,
      inputTokenLimit: typeof record.inputTokenLimit === "number" && Number.isFinite(record.inputTokenLimit) ? record.inputTokenLimit : null,
    });
  }
  return models;
}

/**
 * Lists every text-generation model this key can call, following Google's
 * pagination (`nextPageToken`). Without pagination a key with a large catalog
 * sees an alphabetical fragment of its models, which is how a perfectly usable
 * model can look "unknown" to the picker.
 */
export async function listGeminiModels(apiKey: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<GeminiModelInfo[]> {
  const deadline = withDeadline({ signal: options.signal, timeoutMs: Math.min(30_000, options.timeoutMs ?? 30_000) });
  try {
    const collected: GeminiModelInfo[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MODELS_MAX_PAGES; page++) {
      const response = await fetch(modelsPageUrl(pageToken), {
        method: "GET",
        headers: { "x-goog-api-key": apiKey, Accept: "application/json" },
        signal: deadline.signal,
      });
      if (!response.ok) throw classifyStatus(response.status, await providerErrorMessage(response));
      const body = (await response.json().catch(() => null)) as { models?: unknown; nextPageToken?: unknown } | null;
      if (!body || typeof body !== "object") throw new AiError("malformed_response", "Gemini returned an unreadable model list.");
      for (const model of toModelInfo(body.models)) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        collected.push(model);
      }
      pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
      if (!pageToken) break;
    }
    const byId = new Map(collected.map(model => [model.id, model]));
    return rankGeminiModels(collected.map(model => model.id)).map(id => byId.get(id)!).filter(Boolean);
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
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called when Google rejected the strict schema and the request was retried in JSON-only mode. */
  onSchemaFallback?: () => void;
};

/**
 * Gemini's `responseSchema` accepts a strict subset of JSON Schema. This
 * converts the shared provider-neutral schema: type unions such as
 * `["number", "null"]` become `{ type: "number", nullable: true }`, and any
 * keyword Gemini would reject (`additionalProperties`, map-style schemas) is
 * stripped instead of triggering an HTTP 400. The browser-side zod validation
 * in the AI service remains the source of truth for the response contract.
 */
const GEMINI_SCHEMA_KEYS = ["type", "format", "description", "nullable", "enum", "items", "properties", "required", "pattern", "minimum", "maximum", "minItems", "maxItems", "minProperties", "maxProperties"] as const;

type JsonSchemaNode = Record<string, unknown>;

export function toGeminiResponseSchema(node: unknown): JsonSchemaNode {
  if (Array.isArray(node)) return { items: toGeminiResponseSchema(node[0] ?? {}) };
  if (!node || typeof node !== "object") return {};
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of GEMINI_SCHEMA_KEYS) if (key in source) out[key] = source[key];
  if (Array.isArray(out.type)) {
    const types = out.type as string[];
    const nullable = types.includes("null");
    out.type = types.find(kind => kind !== "null") ?? "string";
    if (nullable) out.nullable = true;
  }
  if (out.properties && typeof out.properties === "object") {
    const properties: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(out.properties as Record<string, unknown>)) properties[name] = toGeminiResponseSchema(child);
    out.properties = properties;
    if (Array.isArray(out.required)) out.required = (out.required as string[]).filter(name => name in properties);
  }
  if (out.items) out.items = toGeminiResponseSchema(out.items);
  return out;
}

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
};

/** Candidate finish reasons that mean Google refused to answer. */
const BLOCKED_FINISH_REASONS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE"]);

/** Joins every text part of the first candidate into one JSON string. */
function candidateText(body: GeminiResponse): string | null {
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map(part => (typeof part.text === "string" ? part.text : "")).join("");
  return text.length > 0 ? text : null;
}

/** Parses a candidate's text, tolerating a fenced JSON block. */
function parseCandidateJson(content: string): unknown {
  const text = content.trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : text);
}

/**
 * Requests a strict structured completion from Gemini and returns the parsed
 * JSON payload. The caller owns schema validation and grounding checks.
 */
export async function requestStructuredCompletion(request: StructuredRequest): Promise<unknown> {
  const deadline = withDeadline({ signal: request.signal, timeoutMs: request.timeoutMs ?? 120_000 });
  // Normalized exactly once: `models/models/…` can never be built.
  const model = encodeURIComponent(normalizeGeminiModelId(request.model));
  if (!model) throw new AiError("model_not_found", "No Gemini model is selected. Choose one in AI settings.");
  const url = `${GEMINI_BASE_URL}/models/${model}:generateContent`;
  const generationConfig = (withSchema: boolean) => ({
    temperature: request.temperature ?? 0.1,
    responseMimeType: "application/json",
    ...(withSchema ? { responseSchema: toGeminiResponseSchema(request.schema) } : {}),
  });
  const send = (withSchema: boolean) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": request.apiKey, Accept: "application/json" },
      signal: deadline.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.user }] }],
        generationConfig: generationConfig(withSchema),
      }),
    });
  try {
    let response = await send(true);
    let providerMessage = "";
    if (!response.ok) {
      providerMessage = await providerErrorMessage(response);
      // A 400 that is not a key/model complaint means Google rejected the
      // request shape (usually a schema keyword its `responseSchema` subset does
      // not accept for this model). Retry once in plain JSON mode: the
      // browser-side zod + grounding validation still enforces the full
      // contract, so the result is exactly as safe, and the feature keeps
      // working instead of hard-failing.
      const canRetryAsJsonOnly =
        response.status === 400 &&
        !isKeyRejection(400, providerMessage) &&
        !MODEL_NOT_FOUND_HINT.test(providerMessage) &&
        !MODEL_UNSUPPORTED_HINT.test(providerMessage);
      if (canRetryAsJsonOnly) {
        request.onSchemaFallback?.();
        response = await send(false);
        providerMessage = response.ok ? "" : await providerErrorMessage(response);
      }
      if (!response.ok) throw classifyStatus(response.status, providerMessage);
    }
    const body = (await response.json().catch(() => null)) as GeminiResponse | null;
    if (!body || typeof body !== "object") throw new AiError("malformed_response", "Gemini returned an empty response. Please retry.");
    if (body.promptFeedback?.blockReason) throw new AiError("blocked", `Gemini blocked this request (${body.promptFeedback.blockReason}). Adjust the journal data wording and retry.`);
    const finishReason = body.candidates?.[0]?.finishReason;
    const content = candidateText(body);
    if (content == null) {
      if (finishReason && BLOCKED_FINISH_REASONS.has(finishReason)) throw new AiError("blocked", `Gemini refused to answer (${finishReason}). Adjust the journal data wording and retry.`);
      if (finishReason === "MAX_TOKENS") throw new AiError("malformed_response", "Gemini hit its output limit before finishing the report. Retry, or choose a model with a larger output budget.");
      throw new AiError("malformed_response", "Gemini returned an empty response. Please retry.");
    }
    if (finishReason && BLOCKED_FINISH_REASONS.has(finishReason)) throw new AiError("blocked", `Gemini refused to answer (${finishReason}). Adjust the journal data wording and retry.`);
    let parsed: unknown;
    try {
      parsed = parseCandidateJson(content);
    } catch {
      if (finishReason === "MAX_TOKENS") throw new AiError("schema_error", "Gemini's report was cut off before the JSON was complete. Retry, or choose a model with a larger output budget.");
      throw new AiError("malformed_response", "Gemini returned an unreadable response. Please retry.");
    }
    return parsed;
  } catch (error) {
    return rethrowTransport(error, deadline);
  } finally {
    deadline.cleanup();
  }
}
