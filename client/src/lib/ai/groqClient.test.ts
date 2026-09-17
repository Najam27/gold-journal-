import { afterEach, describe, expect, it, vi } from "vitest";
import { GROQ_CHAT_COMPLETIONS_URL, GROQ_MODELS_URL, listGroqModels, normalizeModelList, requestGroqStructuredCompletion, toGroqJsonSchema } from "./groqClient";
import { AiError } from "./aiTypes";

const KEY = "gsk_test_only_key_0123456789abcdef";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function completionOk(content: string) {
  return jsonResponse({ choices: [{ message: { content }, finish_reason: "stop" }] });
}

const MODELS_PAGE = {
  data: [
    { id: "openai/gpt-oss-120b", owned_by: "openai", context_window: 131_072 },
    { id: "llama-3.3-70b-versatile", owned_by: "groq", context_window: 131_072 },
    { id: "whisper-large-v3", owned_by: "openai" },
  ],
};

/** GET (model listing) vs POST (chat completion) routing, like the real client. */
function stubTransport(
  post: (callIndex: number) => Response | Promise<Response>,
  get: () => Response | Promise<Response> = () => jsonResponse(MODELS_PAGE),
) {
  let postCalls = 0;
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if (!init || (init.method ?? "GET").toUpperCase() === "GET") return Promise.resolve(get());
    return Promise.resolve(post(postCalls++));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function request(overrides: Partial<Parameters<typeof requestGroqStructuredCompletion>[0]> = {}) {
  return {
    apiKey: KEY,
    model: "openai/gpt-oss-120b",
    system: "system",
    user: "user",
    schemaName: "test_schema",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" }, note: { type: ["string", "null"] } },
      required: ["ok", "note"],
    },
    ...overrides,
  };
}

function postBodies(fetchMock: ReturnType<typeof stubTransport>) {
  return fetchMock.mock.calls
    .filter(call => ((call[1] as RequestInit | undefined)?.method ?? "").toUpperCase() === "POST")
    .map(call => JSON.parse(String((call[1] as RequestInit).body)));
}

describe("browser Groq client", () => {
  it("calls Groq directly over HTTPS and never puts the key in the URL or body", async () => {
    const fetchMock = stubTransport(() => completionOk('{"ok":true,"note":null}'));
    await expect(requestGroqStructuredCompletion(request())).resolves.toEqual({ ok: true, note: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(GROQ_CHAT_COMPLETIONS_URL);
    expect(String(url)).not.toContain(KEY);
    expect(String((init as RequestInit).body)).not.toContain(KEY);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
  });

  it("uses strict json_schema for a strict-capable model and json_object for the rest", async () => {
    const strict = stubTransport(() => completionOk('{"ok":true,"note":null}'));
    await requestGroqStructuredCompletion(request({ model: "openai/gpt-oss-120b" }));
    const strictBody = postBodies(strict)[0];
    expect(strictBody.response_format.type).toBe("json_schema");
    expect(strictBody.response_format.json_schema).toMatchObject({ name: "test_schema", strict: true });

    const bestEffort = stubTransport(() => completionOk('{"ok":true,"note":null}'));
    await requestGroqStructuredCompletion(request({ model: "llama-3.3-70b-versatile" }));
    const looseBody = postBodies(bestEffort)[0];
    expect(looseBody.response_format).toEqual({ type: "json_object" });
    expect(looseBody).not.toHaveProperty("reasoning_effort");
  });

  it("sends low reasoning effort for Groq reasoning models so the budget is not spent thinking", async () => {
    const fetchMock = stubTransport(() => completionOk('{"ok":true,"note":null}'));
    await requestGroqStructuredCompletion(request({ model: "openai/gpt-oss-120b" }));
    expect(postBodies(fetchMock)[0].reasoning_effort).toBe("low");
  });

  it("makes every object strict-compatible and requires every declared property", () => {
    const converted = toGroqJsonSchema({
      type: "object",
      properties: {
        name: { type: "string" },
        score: { type: ["number", "null"] },
        nested: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
      required: ["name"],
    });
    expect(converted.additionalProperties).toBe(false);
    expect(converted.required).toEqual(["name", "score", "nested"]);
    const nested = (converted.properties as Record<string, Record<string, unknown>>).nested;
    expect(nested.additionalProperties).toBe(false);
    expect(nested.required).toEqual(["id"]);
    // The nullable contract must survive the conversion untouched.
    expect((converted.properties as Record<string, unknown>).score).toEqual({ type: ["number", "null"] });
  });

  it("strips a fenced JSON code block from the provider response", async () => {
    stubTransport(() => completionOk('```json\n{"ok":true}\n```'));
    await expect(requestGroqStructuredCompletion(request())).resolves.toEqual({ ok: true });
  });

  it("maps provider status codes onto distinct normalized error codes", async () => {
    const cases: Array<[number, string, string]> = [
      [401, "Invalid API Key", "invalid_key"],
      [400, "Invalid API key provided.", "invalid_key"],
      [403, "This API key does not have permission to access this project.", "unauthorized"],
      [403, "You have exceeded your current quota.", "quota_exceeded"],
      [404, "The model `openai/gpt-oss-999` does not exist.", "model_not_found"],
      [400, "The model `llama-3.3-70b-versatile` is decommissioned.", "model_not_found"],
      [400, "`response_format` json_schema is not supported for this model.", "model_unsupported"],
      [429, "Rate limit reached for requests.", "rate_limited"],
      [429, "You exceeded your current quota, check your plan and billing details.", "quota_exceeded"],
      [500, "Internal server error.", "provider_error"],
      [503, "The service is temporarily unavailable.", "provider_error"],
      [400, "Please reduce the length of the messages.", "invalid_request"],
    ];
    for (const [status, message, code] of cases) {
      stubTransport(() => jsonResponse({ error: { message } }, status));
      await expect(requestGroqStructuredCompletion(request())).rejects.toMatchObject({ code });
    }
  });

  it("never echoes the key inside an error message", async () => {
    stubTransport(() => jsonResponse({ error: { message: `Request used ${KEY} and failed.` } }, 401));
    await requestGroqStructuredCompletion(request()).catch((error: unknown) => {
      expect(error).toBeInstanceOf(AiError);
      expect((error as Error).message).not.toContain(KEY);
    });
  });

  it("reports a timeout when the request exceeds its deadline", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    await expect(requestGroqStructuredCompletion(request({ timeoutMs: 5 }))).rejects.toMatchObject({ code: "timeout" });
  });

  it("reports an offline/network failure when fetch rejects without a status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(requestGroqStructuredCompletion(request())).rejects.toMatchObject({ code: "network_error" });
  });

  it("returns a cancelled error when the caller aborts", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const pending = requestGroqStructuredCompletion(request({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects a malformed provider payload instead of returning partial data", async () => {
    stubTransport(() => completionOk("not json at all"));
    await expect(requestGroqStructuredCompletion(request())).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("rejects an empty choice list instead of returning partial data", async () => {
    stubTransport(() => jsonResponse({ choices: [] }));
    await expect(requestGroqStructuredCompletion(request())).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("reports a schema error when the response is cut off at the output limit", async () => {
    stubTransport(() => jsonResponse({ choices: [{ message: { content: '{"ok":' }, finish_reason: "length" }] }));
    await expect(requestGroqStructuredCompletion(request())).rejects.toMatchObject({ code: "schema_error" });
  });

  it("surfaces a model refusal as a blocked error, not a generic provider error", async () => {
    stubTransport(() => jsonResponse({ choices: [{ message: { content: null, refusal: "I cannot help with that." }, finish_reason: "stop" }] }));
    await expect(requestGroqStructuredCompletion(request())).rejects.toMatchObject({ code: "blocked" });
  });

  it("retries exactly once in JSON-object mode when Groq rejects the strict schema", async () => {
    const onSchemaFallback = vi.fn();
    const fetchMock = stubTransport(callIndex =>
      callIndex === 0
        ? jsonResponse({ error: { message: 'Invalid JSON payload received. Unknown name "additionalProperties".' } }, 400)
        : completionOk('{"ok":true}')
    );
    await expect(requestGroqStructuredCompletion(request({ onSchemaFallback }))).resolves.toEqual({ ok: true });
    expect(onSchemaFallback).toHaveBeenCalledTimes(1);
    const bodies = postBodies(fetchMock);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].response_format.type).toBe("json_schema");
    expect(bodies[1].response_format).toEqual({ type: "json_object" });
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
  });

  it("does not retry when Groq rejects the API key itself", async () => {
    const fetchMock = stubTransport(() => jsonResponse({ error: { message: "Invalid API Key" } }, 401));
    await expect(requestGroqStructuredCompletion(request())).rejects.toMatchObject({ code: "invalid_key" });
    expect(postBodies(fetchMock)).toHaveLength(1);
  });

  it("does not retry when the model itself is unavailable", async () => {
    const fetchMock = stubTransport(() => jsonResponse({ error: { message: "The model `openai/gpt-oss-999` does not exist." } }, 404));
    await expect(requestGroqStructuredCompletion(request())).rejects.toMatchObject({ code: "model_not_found" });
    expect(postBodies(fetchMock)).toHaveLength(1);
  });
});

describe("browser Groq model discovery", () => {
  it("lists the key's usable chat models and filters audio, guardrail, and embedding models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(MODELS_PAGE));
    vi.stubGlobal("fetch", fetchMock);
    const models = await listGroqModels(KEY);
    expect(models.map(model => model.id)).toEqual(["openai/gpt-oss-120b", "llama-3.3-70b-versatile"]);
    expect(models[0]).toMatchObject({ contextWindow: 131_072 });
    expect(String(fetchMock.mock.calls[0][0])).toBe(GROQ_MODELS_URL);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
  });

  it("keeps only chat models and de-duplicates them", () => {
    expect(
      normalizeModelList([
        { id: "llama-3.3-70b-versatile" },
        { id: "openai/gpt-oss-120b" },
        { id: "openai/gpt-oss-120b" },
        { id: "whisper-large-v3-turbo" },
        { id: "canopylabs/orpheus-v1-english" },
        { id: "meta-llama/llama-prompt-guard-2-22m" },
        { id: "openai/gpt-oss-safeguard-20b" },
        "bogus",
        null,
      ])
    ).toEqual(["openai/gpt-oss-120b", "llama-3.3-70b-versatile"]);
  });

  it("surfaces an invalid key from the model listing endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Invalid API Key" } }, 401)));
    await expect(listGroqModels(KEY)).rejects.toMatchObject({ code: "invalid_key" });
  });
});
