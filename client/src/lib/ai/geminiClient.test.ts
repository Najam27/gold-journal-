import { afterEach, describe, expect, it, vi } from "vitest";
import { GEMINI_BASE_URL, GEMINI_MODELS_URL, listGeminiModels, normalizeModelList, requestStructuredCompletion, toGeminiResponseSchema } from "./geminiClient";
import { AiError } from "./aiTypes";

const KEY = "AIza-test-only-key-0123456789abcdef";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function geminiOk(content: string) {
  return jsonResponse({ candidates: [{ content: { parts: [{ text: content }] } }] });
}

/** GET (model listing) vs POST (generateContent) routing, like the real client. */
function stubTransport(post: (callIndex: number) => Response | Promise<Response>) {
  let postCalls = 0;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (!init || (init.method ?? "GET").toUpperCase() === "GET") {
      return Promise.resolve(jsonResponse({ models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }] }));
    }
    return Promise.resolve(post(postCalls++));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function request(overrides: Partial<Parameters<typeof requestStructuredCompletion>[0]> = {}) {
  return {
    apiKey: KEY,
    model: "gemini-3.8-flash",
    system: "system",
    user: "user",
    schemaName: "test_schema",
    schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
    ...overrides,
  };
}

describe("browser Gemini client", () => {
  it("calls Gemini directly over HTTPS and never puts the key in the URL or body", async () => {
    const fetchMock = stubTransport(() => geminiOk('{"ok":true}'));
    await expect(requestStructuredCompletion(request())).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${GEMINI_BASE_URL}/models/gemini-3.8-flash:generateContent`);
    expect(String(url)).not.toContain(KEY);
    expect(String((init as RequestInit).body)).not.toContain(KEY);
    expect((init as RequestInit).headers).toMatchObject({ "x-goog-api-key": KEY });
  });

  it("normalizes a double `models/` prefix into exactly one request path segment", async () => {
    const fetchMock = stubTransport(() => geminiOk('{"ok":true}'));
    await requestStructuredCompletion(request({ model: "models/models/gemini-3.8-flash" }));
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${GEMINI_BASE_URL}/models/gemini-3.8-flash:generateContent`);
  });

  it("converts the provider-neutral schema into Gemini's subset", () => {
    const converted = toGeminiResponseSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        score: { type: ["number", "null"] },
        tags: { type: "array", items: { type: "string" } },
        legacy: { type: "object", additionalProperties: { type: "number" } },
      },
      required: ["name", "score", "tags", "legacy", "ghost"],
    });
    expect(converted).not.toHaveProperty("additionalProperties");
    expect((converted.properties as Record<string, unknown>).score).toEqual({ type: "number", nullable: true });
    expect((converted.properties as Record<string, unknown>).legacy).toEqual({ type: "object" });
    // `required` must only name properties that exist, or Google rejects the schema.
    expect(converted.required).toEqual(["name", "score", "tags", "legacy"]);
  });

  it("strips a fenced JSON code block from the provider response", async () => {
    stubTransport(() => geminiOk('```json\n{"ok":true}\n```'));
    await expect(requestStructuredCompletion(request())).resolves.toEqual({ ok: true });
  });

  it("maps provider status codes onto distinct normalized error codes", async () => {
    const cases: Array<[number, string, string]> = [
      [401, "API key not valid. Please pass a valid API key.", "invalid_key"],
      [403, "API key not valid. Please pass a valid API key.", "invalid_key"],
      [404, "models/gemini-1.0-ultra is not found for API version v1beta", "model_not_found"],
      [400, "The model gemini-legacy does not exist.", "model_not_found"],
      [400, "This model is not supported for generateContent.", "model_unsupported"],
      [429, "Requests per minute limit exceeded.", "rate_limited"],
      [429, "You exceeded your current quota, check your plan and billing details.", "quota_exceeded"],
      [500, "Internal error.", "provider_error"],
      [503, "The service is unavailable.", "provider_error"],
    ];
    for (const [status, message, code] of cases) {
      stubTransport(() => jsonResponse({ error: { message } }, status));
      await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code });
    }
  });

  it("treats a Gemini 400 API-key complaint as an invalid key, not a generic provider error", async () => {
    stubTransport(() => jsonResponse({ error: { message: "API key not valid. Please pass a valid API key." } }, 400));
    await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code: "invalid_key" });
  });

  it("never echoes the key inside an error message", async () => {
    stubTransport(() => jsonResponse({}, 403));
    await requestStructuredCompletion(request()).catch((error: unknown) => {
      expect(error).toBeInstanceOf(AiError);
      expect((error as Error).message).not.toContain(KEY);
    });
  });

  it("reports a timeout when the request exceeds its deadline", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    await expect(requestStructuredCompletion(request({ timeoutMs: 5 }))).rejects.toMatchObject({ code: "timeout" });
  });

  it("reports an offline/network failure when fetch rejects without a status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code: "network_error" });
  });

  it("rejects a malformed provider payload instead of returning partial data", async () => {
    stubTransport(() => geminiOk("not json at all"));
    await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("rejects an empty candidate list instead of returning partial data", async () => {
    stubTransport(() => jsonResponse({ candidates: [] }));
    await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("surfaces a safety block as a blocked error, not a generic provider error", async () => {
    stubTransport(() => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }));
    await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code: "blocked" });
  });

  it("surfaces a SAFETY finish reason as a blocked error", async () => {
    stubTransport(() => jsonResponse({ candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] }));
    await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code: "blocked" });
  });

  it("reports a schema error when the response is cut off at the output limit", async () => {
    stubTransport(() => jsonResponse({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"ok":' }] } }] }));
    await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code: "schema_error" });
  });

  it("returns a cancelled error when the caller aborts", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const pending = requestStructuredCompletion(request({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("retries once in plain JSON mode when Google rejects only the schema shape", async () => {
    const onSchemaFallback = vi.fn();
    const fetchMock = stubTransport(callIndex =>
      callIndex === 0
        ? jsonResponse({ error: { message: 'Invalid JSON payload received. Unknown name "additionalProperties".' } }, 400)
        : geminiOk('{"ok":true}')
    );
    await expect(requestStructuredCompletion(request({ onSchemaFallback }))).resolves.toEqual({ ok: true });
    expect(onSchemaFallback).toHaveBeenCalledTimes(1);
    const attempts = fetchMock.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === "POST");
    expect(attempts).toHaveLength(2);
    const first = JSON.parse(String((attempts[0][1] as RequestInit).body));
    const second = JSON.parse(String((attempts[1][1] as RequestInit).body));
    expect(first.generationConfig.responseSchema).toBeDefined();
    expect(second.generationConfig.responseSchema).toBeUndefined();
    expect(second.generationConfig.responseMimeType).toBe("application/json");
  });

  it("does not retry when Google rejects the API key itself", async () => {
    const fetchMock = stubTransport(() => jsonResponse({ error: { message: "API key not valid. Please pass a valid API key." } }, 400));
    await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code: "invalid_key" });
    const attempts = fetchMock.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === "POST");
    expect(attempts).toHaveLength(1);
  });

  it("does not retry when the model itself is unavailable", async () => {
    const fetchMock = stubTransport(() => jsonResponse({ error: { message: "models/gemini-1.0-ultra is not found for API version v1beta" } }, 400));
    await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code: "model_not_found" });
    const attempts = fetchMock.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === "POST");
    expect(attempts).toHaveLength(1);
  });

  it("never leaks a key-shaped string from the provider's own error text", async () => {
    // A fresh Response per attempt: the body can only be read once.
    stubTransport(() => jsonResponse({ error: { message: `Request used ${KEY} and failed.` } }, 400));
    await requestStructuredCompletion(request()).catch((error: unknown) => {
      expect((error as Error).message).not.toContain(KEY);
      expect((error as Error).message).toContain("[redacted]");
    });
  });
});

describe("browser Gemini model discovery", () => {
  it("lists the key's usable models, keeping only generateContent text models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        models: [
          { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1_048_576 },
          { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.1-flash-image", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const models = await listGeminiModels(KEY);
    expect(models.map(model => model.id)).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    expect(models[0]).toMatchObject({ label: "Gemini 2.5 Flash", inputTokenLimit: 1_048_576 });
    expect(String(fetchMock.mock.calls[0][0])).toContain(GEMINI_MODELS_URL);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ "x-goog-api-key": KEY });
  });

  it("follows nextPageToken so a large catalog is not truncated", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "page-2" }))
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: ["generateContent"] }] }));
    vi.stubGlobal("fetch", fetchMock);
    const models = await listGeminiModels(KEY);
    expect(models.map(model => model.id)).toEqual(["gemini-3.8-flash", "gemini-3.1-pro-preview"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("pageToken=page-2");
  });

  it("keeps only models that can generate content and de-duplicates them", () => {
    expect(
      normalizeModelList([
        { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "bogus" },
        null,
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      ])
    ).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
  });

  it("surfaces an invalid key from the model listing endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { message: "API key not valid." } }, 400)));
    await expect(listGeminiModels(KEY)).rejects.toMatchObject({ code: "invalid_key" });
  });
});
