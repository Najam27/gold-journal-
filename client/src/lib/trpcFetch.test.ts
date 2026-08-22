import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_REQUEST_TIMEOUT_MS, AI_UNEXPECTED_API_RESPONSE_MESSAGE, API_REQUEST_TIMEOUT_MESSAGE, API_REQUEST_TIMEOUT_MS, fetchTrpcResponse, PREVIEW_API_UNAVAILABLE_MESSAGE, trpcTimeoutMs, UNEXPECTED_API_RESPONSE_MESSAGE } from "./trpcFetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("tRPC response guard", () => {
  it("returns JSON API responses while retaining credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetch;

    await expect(fetchTrpcResponse("/api/trpc/journal.get")).resolves.toBeInstanceOf(Response);
    expect(fetch).toHaveBeenCalledWith("/api/trpc/journal.get", expect.objectContaining({ credentials: "include" }));
  });

  it("aborts a hung API request instead of leaving protected loading pending forever", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true })));
    const pending = fetchTrpcResponse("/api/trpc/auth.me");
    const rejection = expect(pending).rejects.toThrow(API_REQUEST_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
    await rejection;
    vi.useRealTimers();
  });

  it("reserves the selected two-minute request window for all AI mutations while normal APIs stay short", () => {
    expect(AI_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(trpcTimeoutMs("/api/trpc/analysis.ai?batch=1")).toBe(AI_REQUEST_TIMEOUT_MS);
    expect(trpcTimeoutMs("/api/trpc/mt5.riskCoach?batch=1")).toBe(AI_REQUEST_TIMEOUT_MS);
    expect(trpcTimeoutMs("/api/trpc/journal.get?batch=1")).toBe(API_REQUEST_TIMEOUT_MS);
  });

  it("converts terminated-preview HTML responses into a recoverable error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("<!doctype html><title>Sandbox unavailable</title>", { status: 502, headers: { "content-type": "text/html", "x-e2b-error-code": "PROXY_SANDBOX_NOT_FOUND" } }));

    await expect(fetchTrpcResponse("/api/trpc/mt5.workspace")).rejects.toThrow(PREVIEW_API_UNAVAILABLE_MESSAGE);
  });

  it("rejects any other non-JSON API response before the tRPC parser attempts JSON parsing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("<!doctype html><title>Unexpected</title>", { status: 200, headers: { "content-type": "text/html" } }));

    await expect(fetchTrpcResponse("/api/trpc/journal.get")).rejects.toThrow(UNEXPECTED_API_RESPONSE_MESSAGE);
  });

  it("explains the verified deployed HTML response on AI routes without leaking server details", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("<!doctype html><title>Unexpected</title>", { status: 502, headers: { "content-type": "text/html" } }));

    await expect(fetchTrpcResponse("/api/trpc/analysis.ai?batch=1")).rejects.toThrow(AI_UNEXPECTED_API_RESPONSE_MESSAGE);
  });
});
