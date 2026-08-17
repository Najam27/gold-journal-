import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTrpcResponse, PREVIEW_API_UNAVAILABLE_MESSAGE, UNEXPECTED_API_RESPONSE_MESSAGE } from "./trpcFetch";

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

  it("converts terminated-preview HTML responses into a recoverable error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("<!doctype html><title>Sandbox unavailable</title>", { status: 502, headers: { "content-type": "text/html", "x-e2b-error-code": "PROXY_SANDBOX_NOT_FOUND" } }));

    await expect(fetchTrpcResponse("/api/trpc/mt5.workspace")).rejects.toThrow(PREVIEW_API_UNAVAILABLE_MESSAGE);
  });

  it("rejects any other non-JSON API response before the tRPC parser attempts JSON parsing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("<!doctype html><title>Unexpected</title>", { status: 200, headers: { "content-type": "text/html" } }));

    await expect(fetchTrpcResponse("/api/trpc/journal.get")).rejects.toThrow(UNEXPECTED_API_RESPONSE_MESSAGE);
  });
});
