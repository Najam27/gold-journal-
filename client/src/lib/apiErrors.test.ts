import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ERROR_COPY, apiErrorCategory, classifyApiError, createCorrelationId, logApiFailure, tagApiError } from "./apiErrors";

afterEach(() => vi.restoreAllMocks());

describe("api error classification", () => {
  it("maps a client-side abort to the timeout category", () => {
    const error = tagApiError(new Error("The API request timed out. Check the deployment and network connection, then retry."), "NETWORK_TIMEOUT");
    const facts = classifyApiError(error);
    expect(facts.category).toBe("NETWORK_TIMEOUT");
    expect(facts.retryable).toBe(true);
    expect(facts.title).toBe(API_ERROR_COPY.NETWORK_TIMEOUT.title);
  });

  it("distinguishes a session failure from a missing account and from a server error", () => {
    expect(classifyApiError({ message: "Unauthorized", data: { code: "UNAUTHORIZED" } }).category).toBe("AUTH_ERROR");
    expect(classifyApiError({ message: "That trading account is unavailable." }).category).toBe("ACCOUNT_NOT_FOUND");
    expect(classifyApiError({ message: "Internal server error", data: { httpStatus: 500 } }).category).toBe("SERVER_ERROR");
    expect(classifyApiError({ message: "Something exploded" }).category).toBe("SERVER_ERROR");
  });

  it("separates database, MT5, and payload failures instead of reporting one generic timeout", () => {
    expect(classifyApiError({ message: "Supabase database is unavailable. Please retry shortly." }).category).toBe("DATABASE_ERROR");
    expect(classifyApiError({ message: "Supabase account balance aggregate is unavailable: query timed out" }).category).toBe("DATABASE_TIMEOUT");
    expect(classifyApiError({ message: "MT5 rejected the API key (AUTH_REVOKED)" }).category).toBe("MT5_AUTH_ERROR");
    expect(classifyApiError({ message: "MT5 history reconstruction failed for position 12" }).category).toBe("MT5_HISTORY_ERROR");
    expect(classifyApiError({ message: "No active MT5 connection is available for this journal account." }).category).toBe("MT5_NOT_CONNECTED");
    expect(classifyApiError({ message: "The EA sent an unsupported payload version" }).category).toBe("MT5_PAYLOAD_ERROR");
    expect(classifyApiError({ message: "The API returned an unexpected non-JSON response." }).category).toBe("PAYLOAD_ERROR");
  });

  it("never exposes a retry-free category as retryable", () => {
    for (const category of ["AUTH_ERROR", "ACCOUNT_NOT_FOUND", "MT5_AUTH_ERROR", "MT5_CONFIG_ERROR"] as const) {
      expect(classifyApiError(tagApiError(new Error("x"), category)).retryable).toBe(false);
    }
  });

  it("keeps secrets and response bodies out of the failure log", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const correlationId = createCorrelationId();
    logApiFailure({
      request: "https://gold-journal.test/api/trpc/journal.get?batch=1",
      correlationId,
      durationMs: 15_000,
      accountId: 12,
      error: { message: "The API request timed out.", status: 504, data: { code: "TIMEOUT" } },
    });

    expect(warn.mock.calls[0][0]).toBe("[API]");
    const line = String(warn.mock.calls[0][1]);
    const payload = JSON.parse(line);
    expect(payload).toMatchObject({ correlationId, accountId: 12, durationMs: 15_000, request: "/api/trpc/journal.get", category: expect.any(String) });
    // Exactly the safe key set: no request body, no headers, no credentials.
    expect(Object.keys(payload)).toEqual(["correlationId", "request", "accountId", "durationMs", "status", "code", "category", "message"]);
    expect(line).not.toContain("?batch=1");
    expect(line).not.toContain("service_role");
  });

  it("tags an untagged error without overwriting an existing category", () => {
    const error = new Error("boom");
    expect(apiErrorCategory(error)).toBeUndefined();
    tagApiError(error, "DATABASE_ERROR");
    expect(apiErrorCategory(error)).toBe("DATABASE_ERROR");
    tagApiError(error, "SERVER_ERROR");
    expect(apiErrorCategory(error)).toBe("DATABASE_ERROR");
  });
});
