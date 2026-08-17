/** @vitest-environment jsdom */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionRecovery } from "./SessionRecovery";

describe("SessionRecovery", () => {
  it("offers safe retry and session-reconnect actions without changing journal data", () => {
    const retry = vi.fn(); const reconnect = vi.fn();
    render(<SessionRecovery onRetry={retry} onReconnect={reconnect} />);
    expect(screen.getByText("Your journal is taking longer than expected.")).toBeTruthy();
    expect(screen.getByText("WORKSTATION STATUS")).toBeTruthy();
    expect(screen.getByText("Private records locked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry secure sync" }));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect session" }));
    expect(retry).toHaveBeenCalledTimes(1); expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("turns reconnect into a safe recheck action when OAuth is unavailable", () => {
    const retry = vi.fn(); const reconnect = vi.fn();
    render(<SessionRecovery onRetry={retry} onReconnect={reconnect} reconnectStatus="unavailable" />);
    expect(screen.getByRole("alert").textContent).toContain("Secure sign-in is temporarily unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Recheck sign-in service" }));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
