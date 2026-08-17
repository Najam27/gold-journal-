// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JOURNAL_RETRY_EVENT, Loading, QueryError } from "./GoldJournal";

describe("Gold Journal protected loader", () => {
  afterEach(() => vi.useRealTimers());

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

  it("renders the query-error retry action without crashing when protected data is unavailable", () => {
    const retry = vi.fn();
    render(<QueryError error={new Error("Cloud database is unavailable.")} onRetry={retry} />);
    expect(screen.getByText("Cloud database is unavailable.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
