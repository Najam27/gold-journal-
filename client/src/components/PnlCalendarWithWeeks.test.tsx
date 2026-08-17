// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));

import { PnlCalendarWithWeeks } from "./PnlCalendarWithWeeks";

afterEach(() => cleanup());

describe("PnlCalendarWithWeeks", () => {
  it("renders a weekly P&L total after the calendar days", () => {
    render(<PnlCalendarWithWeeks trades={[{ tradeDate: new Date("2026-08-03T12:00:00"), pnl: "100" }, { tradeDate: new Date("2026-08-06T12:00:00"), pnl: "-20" }]} />);
    expect(screen.getAllByText(/ending/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("$80.00").length).toBeGreaterThan(1);
    expect(document.querySelector(".week-summary-card.profit")).toBeTruthy();
    expect(document.querySelector(".week-summary-card.flat")).toBeTruthy();
    const populatedDay = screen.getByRole("button", { name: /03\/08\/2026: \$100\.00, 1 trades/i });
    expect(populatedDay.className).toContain("gain");
    expect(populatedDay.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(populatedDay);
    expect(populatedDay.className).toContain("selected");
    expect(populatedDay.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /previous month/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /next month/i })).toBeTruthy();
  });
});
