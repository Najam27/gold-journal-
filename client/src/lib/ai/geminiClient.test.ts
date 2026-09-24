import { afterEach, describe, expect, it, vi } from "vitest";
import { GEMINI_BASE_URL, GEMINI_MODELS_URL, listGeminiModels, normalizeGeminiModelList, requestGeminiStructuredCompletion, toGeminiJsonSchema } from "./geminiClient";
import { AiError } from "./aiTypes";

const KEY = "AIzaSyTestOnlyGeminiKey0123456789";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function completionOk(payload: unknown) {
  return jsonResponse({ candidates: [{ content: { parts: [{ text: typeof payload === "string" ? payload : JSON.stringify(payload) }] }, finishReason: "STOP" }] });
}

function geminiError(status: number, statusText: string, message: string) {
  return jsonResponse({ error: { code: status, status: statusText, message } }, status);
}

const MODELS_PAGE = {
  models: [
    { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] },
    { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
    { name: "models/embedding-001", supportedGenerationMethods: ["embedContent", "generateContent"] },
    { name: "not a model" },
  ],
};

function stubbedPost(post: (callIndex: number) => Response | Promise<Response>) {
  let postCalls = 0;
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "GET") return Promise.resolve(jsonResponse(MODELS_PAGE));
    return Promise.resolve(post(postCalls++));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function postBodies(fetchMock: ReturnType<typeof stubbedPost>) {
  return fetchMock.mock.calls
    .filter(call => ((call[1] as RequestInit | undefined)?.method ?? "").toUpperCase() === "POST")
    .map(call => JSON.parse(String((call[1] as RequestInit).body)));
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: KEY,
    model: "gemini-2.5-flash",
    system: "system",
    user: "user",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean" },
        note: { type: ["string", "null"] },
        items: { type: "array", items: { $ref: "#/$defs/item" } },
      },
      required: ["ok", "note", "items"],
      $defs: { item: { type: "object", additionalProperties: false, properties: { id: { type: "string", pattern: "^[a-z]+$" } }, required: ["id"] } },
    },
    ...overrides,
  } as Parameters<typeof requestGeminiStructuredCompletion>[0];
}

describe("browser Gemini client", () => {
  it("calls generateContent directly over HTTPS and never puts the key in the URL or body", async () => {
    const fetchMock = stubbedPost(() => completionOk({ ok: true, note: null }));
    await expect(requestGeminiStructuredCompletion(request())).resolves.toEqual({ ok: true, note: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${GEMINI_BASE_URL}/models/gemini-2.5-flash:generateContent`);
    expect(String(url)).not.toContain(KEY);
    expect(String((init as RequestInit).body)).not.toContain(KEY);
    expect((init as RequestInit).headers).toMatchObject({ "x-goog-api-key": KEY });
  });

  it("asks for JSON output and sends the projected schema", async () => {
    const fetchMock = stubbedPost(() => completionOk({ ok: true, note: null }));
    await requestGeminiStructuredCompletion(request({ maxCompletionTokens: 2_400 }));
    expect(postBodies(fetchMock)[0].generationConfig).toMatchObject({ responseMimeType: "application/json", maxOutputTokens: 2_400 });
    expect(postBodies(fetchMock)[0].generationConfig.responseSchema.type).toBe("object");
    expect(postBodies(fetchMock)[0].systemInstruction.parts[0].text).toBe("system");
  });

  it("projects the strict schema onto Gemini's supported subset", () => {
    const converted = toGeminiJsonSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        note: { type: ["string", "null"] },
        nested: { type: "object", properties: { id: { type: "string", pattern: "^[a-z]+$", maxLength: 8 } }, required: ["id"] },
        items: { type: "array", items: { $ref: "#/$defs/item" } },
      },
      required: ["note", "nested", "items"],
      $defs: { item: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    });
    const properties = converted.properties as Record<string, Record<string, unknown>>;
    // Unsupported keywords are dropped instead of being sent (Gemini 400s on them).
    expect(converted).not.toHaveProperty("additionalProperties");
    expect(converted).not.toHaveProperty("$defs");
    expect(properties.nested).not.toHaveProperty("additionalProperties");
    expect((properties.nested.properties as Record<string, Record<string, unknown>>).id).toEqual({ type: "string" });
    // A nullable field becomes the documented `nullable` flag.
    expect(properties.note).toEqual({ type: "string", nullable: true });
    // A reference is inlined: Gemini does not resolve `$ref`.
    expect(properties.items).toEqual({ type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } });
  });

  it("strips a fenced JSON code block from the provider response", async () => {
    stubbedPost(() => completionOk('```json\n{"ok":true}\n```'));
    await expect(requestGeminiStructuredCompletion(request())).resolves.toEqual({ ok: true });
  });

  it("maps Gemini status codes onto distinct normalized error codes", async () => {
    const cases: Array<[number, string, string, string]> = [
      [401, "UNAUTHENTICATED", "API key not valid. Please pass a valid API key.", "invalid_key"],
      [400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", "invalid_key"],
      [403, "PERMISSION_DENIED", "The caller does not have permission.", "unauthorized"],
      [403, "PERMISSION_DENIED", "You exceeded your current quota, please check your plan.", "quota_exceeded"],
      [429, "RESOURCE_EXHAUSTED", "Quota exceeded for quota metric 'Generate requests per minute'.", "quota_exceeded"],
      [429, "RESOURCE_EXHAUSTED", "Too many requests, slow down.", "rate_limited"],
      [404, "NOT_FOUND", "models/gemini-9.9 is not found for API version v1beta.", "model_not_found"],
      [503, "UNAVAILABLE", "The model is overloaded. Please try again later.", "provider_error"],
    ];
    for (const [status, statusText, message, code] of cases) {
      stubbedPost(() => geminiError(status, statusText, message));
      await expect(requestGeminiStructuredCompletion(request())).rejects.toMatchObject({ code });
    }
  });

  it("retries exactly once in JSON mode when Gemini rejects the response schema", async () => {
    const onSchemaFallback = vi.fn();
    const fetchMock = stubbedPost(callIndex =>
      callIndex === 0
        ? geminiError(400, "INVALID_ARGUMENT", "Invalid JSON payload received. Unknown name \"additionalProperties\".")
        : completionOk({ ok: true })
    );
    await expect(requestGeminiStructuredCompletion(request({ onSchemaFallback }))).resolves.toEqual({ ok: true });
    expect(onSchemaFallback).toHaveBeenCalledTimes(1);
    const bodies = postBodies(fetchMock);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].generationConfig.responseSchema).toBeDefined();
    expect(bodies[1].generationConfig).not.toHaveProperty("responseSchema");
    expect(bodies[1].generationConfig.responseMimeType).toBe("application/json");
  });

  it("does not retry when Gemini rejects the key itself", async () => {
    const fetchMock = stubbedPost(() => geminiError(401, "UNAUTHENTICATED", "API key not valid."));
    await expect(requestGeminiStructuredCompletion(request())).rejects.toMatchObject({ code: "invalid_key" });
    expect(postBodies(fetchMock)).toHaveLength(1);
  });

  it("never echoes the key inside an error message", async () => {
    stubbedPost(() => geminiError(401, "UNAUTHENTICATED", `Request used ${KEY} and failed.`));
    await requestGeminiStructuredCompletion(request()).catch((error: unknown) => {
      expect(error).toBeInstanceOf(AiError);
      expect((error as Error).message).not.toContain(KEY);
    });
  });

  it("reports a blocked, truncated, empty, and unreadable response distinctly", async () => {
    stubbedPost(() => jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }));
    await expect(requestGeminiStructuredCompletion(request())).rejects.toMatchObject({ code: "blocked" });

    stubbedPost(() => jsonResponse({ candidates: [{ content: { parts: [{ text: "{\"ok\":" }] }, finishReason: "MAX_TOKENS" }] }));
    await expect(requestGeminiStructuredCompletion(request())).rejects.toMatchObject({ code: "schema_error" });

    stubbedPost(() => jsonResponse({ candidates: [] }));
    await expect(requestGeminiStructuredCompletion(request())).rejects.toMatchObject({ code: "malformed_response" });

    stubbedPost(() => completionOk("not json at all"));
    await expect(requestGeminiStructuredCompletion(request())).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("reports a timeout and a cancelled request distinctly", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    await expect(requestGeminiStructuredCompletion(request({ timeoutMs: 5 }))).rejects.toMatchObject({ code: "timeout" });

    const controller = new AbortController();
    const pending = requestGeminiStructuredCompletion(request({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("reports an offline/network failure when fetch rejects without a status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(requestGeminiStructuredCompletion(request())).rejects.toMatchObject({ code: "network_error" });
  });
});

describe("browser Gemini model discovery", () => {
  it("lists only the models that can run generateContent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(MODELS_PAGE));
    vi.stubGlobal("fetch", fetchMock);
    const models = await listGeminiModels(KEY);
    expect(models.map(model => model.id)).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    expect(models[0]).toMatchObject({ label: "gemini-2.5-flash · Gemini 2.5 Flash" });
    expect(String(fetchMock.mock.calls[0][0])).toBe(GEMINI_MODELS_URL);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(KEY);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ "x-goog-api-key": KEY });
  });

  it("keeps the usable subset and never offers an embeddings-only model", () => {
    expect(normalizeGeminiModelList(MODELS_PAGE.models)).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    expect(normalizeGeminiModelList([{ name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }])).toEqual([]);
    expect(normalizeGeminiModelList(null)).toEqual([]);
  });

  it("surfaces an invalid key from the model listing endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiError(400, "INVALID_ARGUMENT", "API key not valid.")));
    await expect(listGeminiModels(KEY)).rejects.toMatchObject({ code: "invalid_key" });
  });
});
