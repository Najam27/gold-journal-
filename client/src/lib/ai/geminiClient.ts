/**
 * Minimal, dependency-free Google AI Studio (Gemini) client that runs in the
 * user's browser.
 *
 * The request goes straight from this browser to Google's Generative Language
 * API over HTTPS. It is never proxied through Cloudflare, a Worker, a
 * serverless function, or any Gold Journal backend, and the API key is never
 * placed in a URL, log line, or telemetry payload: the `x-goog-api-key`
 * header carries it on every call.
 */
import { AiError } from "./aiTypes";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_MODELS_URL = `${GEMINI_BASE_URL}/models`;

/** Providers we treat as "the key itself is wrong" regardless of status code. */
function isKeyRejection(status: number, providerMessage: string): boolean {
  if (status === 401 || status === 403) return true;
  if (status === 400 && /API.?key/i.test(providerMessage)) return true;
  return false;
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

function classifyStatus(status: number, providerMessage = ""): AiError {
  if (isKeyRejection(status, providerMessage)) return new AiError("invalid_key", "Google AI rejected this API key. Check the key in AI settings.", status);
  if (status === 404) return new AiError("provider_error", "The selected Google AI model was not found. Pick a different Gemini model in AI settings.", status);
  if (status === 429) return new AiError("rate_limited", "Google AI rate-limited this request. Wait a moment and retry.", status);
  if (status >= 500) return new AiError("provider_error", "The Google AI service is temporarily unavailable. Please retry.", status);
  const detail = sanitizeProviderMessage(providerMessage);
  return new AiError("provider_error", detail ? `Google AI rejected the request (HTTP ${status}): ${detail}` : `Google AI rejected the request (HTTP ${status}). Check the selected model or retry.`, status);
}

function classifyThrown(error: unknown, timedOut: boolean, abortedByUser: boolean): AiError {
  if (abortedByUser) return new AiError("cancelled", "AI request cancelled.");
  if (timedOut) return new AiError("timeout", "AI request timed out. Please retry.");
  if (error instanceof AiError) return error;
  // `fetch` rejects with a TypeError on DNS/offline/CORS failures.
  return new AiError("network_error", "Could not reach Google AI. Check your internet connection and retry.");
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

export type KeyVerification = { label: string; freeTier: boolean; limitRemaining: number | null; /** Gemini model ids this key can actually call. */ models: string[] };

/**
 * Validates a key against Google's public model listing. The key travels only
 * in the `x-goog-api-key` header, never in the URL, and is never persisted.
 */
export async function verifyGoogleApiKey(apiKey: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<KeyVerification> {
  const deadline = withDeadline({ signal: options.signal, timeoutMs: Math.min(20_000, options.timeoutMs ?? 20_000) });
  try {
    const response = await fetch(GEMINI_MODELS_URL, {
      method: "GET",
      headers: { "x-goog-api-key": apiKey, Accept: "application/json" },
      signal: deadline.signal,
    });
    if (!response.ok) throw classifyStatus(response.status, await providerErrorMessage(response));
    const body = (await response.json().catch(() => null)) as { models?: unknown[] } | null;
    if (!body || typeof body !== "object") throw new AiError("malformed_response", "Google AI returned an unreadable key status.");
    const models = normalizeModelList(body.models);
    return { label: models.length > 0 ? `Google AI Studio (${models.length} usable models)` : "Google AI Studio key", freeTier: false, limitRemaining: null, models };
  } catch (error) {
    const { timedOut, abortedByUser } = deadline.flags();
    if (error instanceof Error && error.name === "AbortError" && !timedOut && !abortedByUser) throw new AiError("network_error", "Could not reach Google AI. Check your internet connection and retry.");
    throw classifyThrown(error, timedOut, abortedByUser);
  } finally {
    deadline.cleanup();
  }
}

/**
 * Turns Google's model listing into usable `generateContent` model ids so the
 * settings UI can offer models this specific key is actually allowed to call.
 */
export function normalizeModelList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; supportedGenerationMethods?: unknown };
    if (typeof record.name !== "string") continue;
    const methods = Array.isArray(record.supportedGenerationMethods) ? record.supportedGenerationMethods : [];
    // Only offer models this key can actually run inference on.
    if (!methods.includes("generateContent")) continue;
    const id = record.name.replace(/^models\//, "");
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.sort((a, b) => (a.includes("flash") === b.includes("flash") ? a.localeCompare(b) : a.includes("flash") ? -1 : 1)).slice(0, 40);
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

/** Joins every text part of the first candidate into one JSON string. */
function candidateText(body: GeminiResponse): string | null {
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map(part => (typeof part.text === "string" ? part.text : "")).join("");
  return text.length > 0 ? text : null;
}

/**
 * Requests a strict structured completion from Gemini and returns the parsed
 * JSON payload. The caller owns schema validation and grounding checks.
 */
export async function requestStructuredCompletion(request: StructuredRequest): Promise<unknown> {
  const deadline = withDeadline({ signal: request.signal, timeoutMs: request.timeoutMs ?? 120_000 });
  const model = encodeURIComponent(request.model.replace(/^models\//, ""));
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
      // A 400 that is not a key complaint means Google rejected the request
      // shape (usually a schema keyword its `responseSchema` subset does not
      // accept). Retry once in plain JSON mode: the browser-side zod + grounding
      // validation still enforces the full contract, so the result is exactly as
      // safe, and the feature keeps working instead of hard-failing.
      if (response.status === 400 && !isKeyRejection(400, providerMessage)) {
        response = await send(false);
        providerMessage = response.ok ? "" : await providerErrorMessage(response);
      }
      if (!response.ok) throw classifyStatus(response.status, providerMessage);
    }
    const body = (await response.json().catch(() => null)) as GeminiResponse | null;
    if (!body || typeof body !== "object") throw new AiError("malformed_response", "Google AI returned an empty response. Please retry.");
    if (body.promptFeedback?.blockReason) throw new AiError("provider_error", `Google AI blocked this request (${body.promptFeedback.blockReason}). Adjust the journal data wording and retry.`);
    const content = candidateText(body);
    if (content == null) throw new AiError("malformed_response", "Google AI returned an empty response. Please retry.");
    let parsed: unknown;
    try {
      const text = content.trim();
      const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      parsed = JSON.parse(fenced ? fenced[1] : text);
    } catch {
      throw new AiError("malformed_response", "Google AI returned an unreadable response. Please retry.");
    }
    return parsed;
  } catch (error) {
    const { timedOut, abortedByUser } = deadline.flags();
    if (error instanceof Error && error.name === "AbortError" && !timedOut && !abortedByUser) throw new AiError("network_error", "Could not reach Google AI. Check your internet connection and retry.");
    throw classifyThrown(error, timedOut, abortedByUser);
  } finally {
    deadline.cleanup();
  }
}
