// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { auth: { getSession: mocks.getSession } } }));

import { AUTH_SESSION_LOOKUP_TIMEOUT_MS, getSupabaseAccessToken } from "./authSession";

describe("getSupabaseAccessToken", () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.getSession.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns the current access token", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: "access-token" } } });
    await expect(getSupabaseAccessToken()).resolves.toBe("access-token");
  });

  it("fails closed when Supabase session lookup hangs", async () => {
    mocks.getSession.mockReturnValue(new Promise(() => undefined));
    const tokenPromise = getSupabaseAccessToken();
    await vi.advanceTimersByTimeAsync(AUTH_SESSION_LOOKUP_TIMEOUT_MS);
    await expect(tokenPromise).resolves.toBeUndefined();
  });
});
