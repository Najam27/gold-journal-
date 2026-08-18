// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  useQuery: vi.fn(),
  invalidate: vi.fn(),
  setData: vi.fn(),
  signOut: vi.fn(),
  clearPrivate: vi.fn(),
}));
let authCallback: ((event: string, session: any) => void) | undefined;
let unsubscribe: ReturnType<typeof vi.fn>;

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: mocks.getSession, onAuthStateChange: mocks.onAuthStateChange, signOut: mocks.signOut, refreshSession: vi.fn() } } }));
vi.mock("@/lib/queryClient", () => ({ clearPrivateClientState: mocks.clearPrivate }));
vi.mock("@/lib/trpc", () => ({ trpc: { useUtils: () => ({ auth: { me: { invalidate: mocks.invalidate, setData: mocks.setData } } }), auth: { me: { useQuery: mocks.useQuery } } } }));

import { AUTH_BOOTSTRAP_TIMEOUT_MS, resetAuthForTests, useAuth } from "./useAuth";

const session = { access_token: "redacted-test-token", user: { id: "user-a", email: "trader@example.com" } };
const profile = { id: 7, openId: "user-a", name: "Trader", email: "trader@example.com" };

describe("useAuth state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAuthForTests();
    authCallback = undefined;
    unsubscribe = vi.fn();
    mocks.getSession.mockReset();
    mocks.onAuthStateChange.mockReset().mockImplementation((callback: typeof authCallback) => { authCallback = callback; return { data: { subscription: { unsubscribe } } }; });
    mocks.useQuery.mockReset().mockReturnValue({ data: profile, isLoading: false, error: null, refetch: vi.fn() });
    mocks.invalidate.mockReset();
    mocks.setData.mockReset();
    mocks.signOut.mockReset().mockResolvedValue({ error: null });
    mocks.clearPrivate.mockReset();
  });
  afterEach(() => { resetAuthForTests(); vi.useRealTimers(); });

  it("fails closed into an auth error after a stuck Supabase bootstrap", async () => {
    mocks.getSession.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useAuth());
    expect(result.current.status).toBe("booting");
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS); });
    expect(result.current.loading).toBe(false);
    expect(result.current.status).toBe("error");
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("installs one listener and keeps the dashboard authenticated through token refresh", async () => {
    mocks.getSession.mockResolvedValue({ data: { session }, error: null });
    const first = renderHook(() => useAuth());
    const second = renderHook(() => useAuth());
    await act(async () => { await Promise.resolve(); });
    expect(mocks.onAuthStateChange).toHaveBeenCalledTimes(1);
    expect(first.result.current.status).toBe("authenticated");
    expect(first.result.current.isAuthenticated).toBe(true);
    await act(async () => { authCallback?.("TOKEN_REFRESHED", session); });
    expect(first.result.current.status).toBe("authenticated");
    expect(second.result.current.status).toBe("authenticated");
    expect(first.result.current.loading).toBe(false);
    expect(mocks.clearPrivate).not.toHaveBeenCalled();
  });

  it("keeps authenticated state through a normal component remount", async () => {
    mocks.getSession.mockResolvedValue({ data: { session }, error: null });
    const first = renderHook(() => useAuth());
    await act(async () => { await Promise.resolve(); });
    first.unmount();
    const second = renderHook(() => useAuth());
    expect(second.result.current.status).toBe("authenticated");
    expect(second.result.current.loading).toBe(false);
    expect(mocks.onAuthStateChange).toHaveBeenCalledTimes(1);
  });

  it("clears private cache when the authenticated identity changes", async () => {
    mocks.getSession.mockResolvedValue({ data: { session }, error: null });
    const { result } = renderHook(() => useAuth());
    await act(async () => { await Promise.resolve(); });
    await act(async () => { authCallback?.("SIGNED_IN", { ...session, user: { ...session.user, id: "user-b" } }); });
    expect(result.current.status).toBe("authenticated");
    expect(mocks.clearPrivate).toHaveBeenCalledTimes(1);
  });

  it("keeps authentication established when auth.me fails so the dashboard can show recovery", async () => {
    mocks.getSession.mockResolvedValue({ data: { session }, error: null });
    const profileError = new Error("profile sync unavailable");
    mocks.useQuery.mockReturnValue({ data: null, isLoading: false, error: profileError, refetch: vi.fn() });
    const { result } = renderHook(() => useAuth());
    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe("authenticated");
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.authMeError).toBe(profileError);
  });

  it("transitions to unauthenticated on sign out without returning to booting", async () => {
    mocks.getSession.mockResolvedValue({ data: { session }, error: null });
    const { result } = renderHook(() => useAuth());
    await act(async () => { await Promise.resolve(); });
    await act(async () => { authCallback?.("SIGNED_OUT", null); });
    expect(result.current.status).toBe("unauthenticated");
    expect(result.current.loading).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
  });
});
