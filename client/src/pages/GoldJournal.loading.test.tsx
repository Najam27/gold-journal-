// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProfileRecovery, getAuthGate, JOURNAL_RETRY_EVENT, Loading, QueryError } from "./GoldJournal";

describe("Gold Journal protected loader", () => {
  it("shows the splash only during boot and never for authenticated data loading", () => {
    expect(getAuthGate("booting")).toBe("splash");
    expect(getAuthGate("authenticated")).toBe("dashboard");
    expect(getAuthGate("error")).toBe("auth-error");
    expect(getAuthGate("unauthenticated")).toBe("login");
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("retries the existing secure journal query in place after a slow load", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    window.addEventListener(JOURNAL_RETRY_EVENT, retry);
    render(<Loading />);

    act(() => { vi.advanceTimersByTime(8_000); });
    fireEvent.click(screen.getByRole("button", { name: "Retry secure sync" }));

    expect(retry).toHaveBeenCalledTimes(1);
    window.removeEventListener(JOURNAL_RETRY_EVENT, retry);
  });

  it("keeps the dashboard recovery state actionable when auth.me fails", () => {
    const retry = vi.fn(); const reconnect = vi.fn(); const signOut = vi.fn();
    render(<AuthProfileRecovery error={new Error("profile unavailable")} onRetry={retry} onReconnect={reconnect} onSignOut={signOut} />);
    expect(screen.getByText("Secure profile sync is temporarily unavailable.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect session" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(retry).toHaveBeenCalledTimes(1); expect(reconnect).toHaveBeenCalledTimes(1); expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("renders the query-error retry action without crashing when protected data is unavailable", () => {
    const retry = vi.fn();
    render(<QueryError error={new Error("Cloud database is unavailable.")} onRetry={retry} />);
    expect(screen.getByText("Cloud database is unavailable.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
