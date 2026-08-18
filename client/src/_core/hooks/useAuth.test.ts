// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  useQuery: vi.fn(() => ({ data: null, isLoading: false, error: null })),
  invalidate: vi.fn(),
  setData: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: mocks.getSession, onAuthStateChange: mocks.onAuthStateChange, signOut: vi.fn() } } }));
vi.mock("@/lib/queryClient", () => ({ clearPrivateClientState: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: { useUtils: () => ({ auth: { me: { invalidate: mocks.invalidate, setData: mocks.setData } } }), auth: { me: { useQuery: mocks.useQuery } } } }));

import { AUTH_BOOTSTRAP_TIMEOUT_MS, useAuth } from "./useAuth";

describe("useAuth bootstrap", () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.getSession.mockReset(); mocks.onAuthStateChange.mockClear(); mocks.useQuery.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it("fails closed after a stuck Supabase session request", async () => {
    mocks.getSession.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useAuth());
    expect(result.current.loading).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS); });
    expect(result.current.loading).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
  });
});
