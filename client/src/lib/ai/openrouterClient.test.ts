import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENROUTER_CHAT_URL, OPENROUTER_KEY_URL, requestStructuredCompletion, verifyOpenRouterKey } from "./openrouterClient";
import { AiError } from "./aiTypes";

const KEY = "sk-or-v1-test-only-key-0123456789";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function request(overrides: Partial<Parameters<typeof requestStructuredCompletion>[0]> = {}) {
  return {
    apiKey: KEY,
    model: "test/model",
    system: "system",
    user: "user",
    schemaName: "test_schema",
    schema: { type: "object" },
    ...overrides,
  };
}

describe("browser OpenRouter client", () => {
  it("calls OpenRouter directly over HTTPS and never puts the key in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestStructuredCompletion(request())).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OPENROUTER_CHAT_URL);
    expect(String(url)).not.toContain(KEY);
    expect(String(url)).not.toContain("sk-or");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    expect(String((init as RequestInit).body)).not.toContain(KEY);
  });

  it("strips a fenced JSON code block from the provider response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] })));
    await expect(requestStructuredCompletion(request())).resolves.toEqual({ ok: true });
  });

  it("maps provider status codes onto normalized, credential-free errors", async () => {
    const cases: Array<[number, string]> = [
      [401, "invalid_key"],
      [403, "invalid_key"],
      [429, "rate_limited"],
      [500, "provider_error"],
      [503, "provider_error"],
    ];
    for (const [status, code] of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, status)));
      await expect(requestStructuredCompletion(request())).rejects.toMatchObject({ code });
    }
  });

  it("never echoes the key inside an error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 401)));
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: "not json at all" } }] })));
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

  it("verifies a key against OpenRouter's own key endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { label: "My key", is_free_tier: true, limit_remaining: 12.5 } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyOpenRouterKey(KEY)).resolves.toEqual({ label: "My key", freeTier: true, limitRemaining: 12.5 });
    expect(fetchMock.mock.calls[0][0]).toBe(OPENROUTER_KEY_URL);
  });

  it("surfaces an invalid key from the verification endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 403)));
    await expect(verifyOpenRouterKey(KEY)).rejects.toMatchObject({ code: "invalid_key" });
  });
});
