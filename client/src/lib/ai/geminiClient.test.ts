import { afterEach, describe, expect, it, vi } from "vitest";
import { GEMINI_BASE_URL, GEMINI_MODELS_URL, normalizeModelList, requestStructuredCompletion, toGeminiResponseSchema, verifyGoogleApiKey } from "./geminiClient";
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

function request(overrides: Partial<Parameters<typeof requestStructuredCompletion>[0]> = {}) {
  return {
    apiKey: KEY,
    model: "gemini-2.5-flash",
    system: "system",
    user: "user",
    schemaName: "test_schema",
    schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] },
    ...overrides,
  };
}

describe("browser Google AI (Gemini) client", () => {
  it("calls Google AI directly over HTTPS and never puts the key in the URL or body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(geminiOk('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestStructuredCompletion(request())).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${GEMINI_BASE_URL}/models/gemini-2.5-flash:generateContent`);
    expect(String(url)).not.toContain(KEY);
    expect(String((init as RequestInit).body)).not.toContain(KEY);
    expect((init as RequestInit).headers).toMatchObject({ "x-goog-api-key": KEY });
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiOk('```json\n{"ok":true}\n```')));
    await expect(requestStructuredCompletion(request())).resolves.toEqual({ ok: true });
  });

  it("maps provider status codes onto normalized, credential-free errors", async () => {
    const cases: Array<[number, string]> = [
      [401, "invalid_key"],
      [403, "invalid_key"],
      [429, "rate_limited"],
      [500, "provider_error"],
      [503, "provider_error"],
      [404, "provider_error"],
    ];
    for (const [status, code] of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { message: "nope" } }, status)));
      await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code });
    }
  });

  it("treats a Gemini 400 API-key complaint as an invalid key, not a generic provider error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { message: "API key not valid. Please pass a valid API key." } }, 400)));
    await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code: "invalid_key" });
  });

  it("never echoes the key inside an error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 403)));
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiOk("not json at all")));
    await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("rejects an empty candidate list instead of returning partial data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ candidates: [] })));
    await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code: "malformed_response" });
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "Invalid JSON payload received. Unknown name \"additionalProperties\"." } }, 400))
      .mockResolvedValueOnce(geminiOk('{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestStructuredCompletion(request())).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const second = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(first.generationConfig.responseSchema).toBeDefined();
    expect(second.generationConfig.responseSchema).toBeUndefined();
    expect(second.generationConfig.responseMimeType).toBe("application/json");
  });

  it("does not retry when Google rejects the API key itself", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "API key not valid. Please pass a valid API key." } }, 400));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code: "invalid_key" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never leaks a key-shaped string from the provider's own error text", async () => {
    // A fresh Response per attempt: the body can only be read once.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ error: { message: `Request used ${KEY} and failed.` } }, 400))));
    await requestStructuredCompletion(request()).catch((error: unknown) => {
      expect((error as Error).message).not.toContain(KEY);
      expect((error as Error).message).toContain("[redacted]");
    });
  });

  it("verifies a key against Google's public model listing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        models: [
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyGoogleApiKey(KEY)).resolves.toMatchObject({
      label: "Google AI Studio (2 usable models)",
      models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(GEMINI_MODELS_URL);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ "x-goog-api-key": KEY });
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

  it("surfaces an invalid key from the verification endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: { message: "API key not valid." } }, 400)));
    await expect(verifyGoogleApiKey(KEY)).rejects.toMatchObject({ code: "invalid_key" });
  });
});
