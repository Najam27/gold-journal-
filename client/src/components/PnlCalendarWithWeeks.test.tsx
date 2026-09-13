// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));

import { PnlCalendarWithWeeks } from "./PnlCalendarWithWeeks";

afterEach(() => cleanup());

describe("PnlCalendarWithWeeks", () => {
  // The calendar defaults to the current PKT month, so pin the clock inside
  // August 2026 (12:30 PKT) instead of letting the tests rot every month.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:30:00+05:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a weekly P&L total after the calendar days", () => {
    render(<PnlCalendarWithWeeks trades={[{ tradeDate: new Date("2026-08-03T12:00:00"), pnl: "100" }, { tradeDate: new Date("2026-08-06T12:00:00"), pnl: "-20" }]} />);
    expect(screen.getAllByText(/ending/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("$80.00").length).toBeGreaterThan(1);
    expect(document.querySelector(".week-summary-card.profit")).toBeTruthy();
    expect(document.querySelector(".week-summary-card.flat")).toBeTruthy();
    const populatedDay = screen.getByRole("button", { name: /03 Aug: \$100\.00, 1 trades/i });
    expect(populatedDay.className).toContain("gain");
    expect(populatedDay.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /previous month/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /next month/i })).toBeTruthy();
    fireEvent.click(populatedDay);
    // The open dialog hides the rest of the page from assistive tech, so the
    // highlight is asserted on the button element itself.
    expect(populatedDay.className).toContain("selected");
    expect(populatedDay.getAttribute("aria-pressed")).toBe("true");
  });

  it("groups an adjacent-UTC trade by its PKT calendar day", () => {
    render(<PnlCalendarWithWeeks trades={[{ tradeDate: "2026-08-03T19:30:00.000Z", pnl: "75", result: "WIN" }]} />);
    expect(screen.getByRole("button", { name: /04 Aug: \$75\.00, 1 trades/i })).toBeTruthy();
  });

  it("opens every trade behind a populated day in the daily drill-down dialog", () => {
    render(<PnlCalendarWithWeeks trades={[
      { id: 1, tradeDate: "2026-08-20T04:42:00.000Z", result: "WIN", pnl: "180", risk: "100", reward: "200", session: "London", direction: "BUY" },
      { id: 2, tradeDate: "2026-08-20T06:10:00.000Z", result: "LOSS", pnl: "-40", risk: "100", reward: "200", session: "London", direction: "SELL" },
      { id: 3, tradeDate: "2026-08-20T09:20:00.000Z", result: "WIN", pnl: "95", risk: "50", reward: "150", session: "New York", direction: "BUY" },
      { id: 4, tradeDate: "2026-08-20T12:05:00.000Z", result: "WIN", pnl: "105", risk: "50", reward: "150", session: "New York", direction: "SELL" },
      { id: 5, tradeDate: "2026-08-21T06:00:00.000Z", result: "LOSS", pnl: "-500", risk: "250" },
    ]} />);
    const day = screen.getByRole("button", { name: /20 Aug: \$340\.00, 4 trades/i });
    expect(day.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(day);
    expect(screen.getByText("Thursday, 20 August 2026")).toBeTruthy();
    expect(screen.getByText("Daily P&L")).toBeTruthy();
    expect(document.querySelectorAll(".day-trade-row")).toHaveLength(4);
    expect(screen.getByText("75%")).toBeTruthy();
    // The calendar card and the dialog read the same summary.
    expect(screen.getAllByText("$340.00")).toHaveLength(2);
    const dialog = document.querySelector(".day-trades-dialog") as HTMLElement;
    expect(dialog.textContent).toContain("$180.00");
    expect(dialog.textContent).toContain("-$40.00");
    expect(dialog.textContent).not.toContain("-$500.00");
  });

  it("keeps empty days inactive and unopenable", () => {
    render(<PnlCalendarWithWeeks trades={[{ id: 1, tradeDate: "2026-08-20T04:42:00.000Z", result: "WIN", pnl: "180" }]} />);
    const empty = screen.getByRole("button", { name: /19 Aug: no trades/i }) as HTMLButtonElement;
    expect(empty.disabled).toBe(true);
    fireEvent.click(empty);
    expect(screen.queryByText("Daily P&L")).toBeNull();
  });

  it("closes and resets the dialog when the month changes so trades never leak", () => {
    render(<PnlCalendarWithWeeks trades={[
      { id: 1, tradeDate: "2026-08-20T04:42:00.000Z", result: "WIN", pnl: "180" },
      { id: 2, tradeDate: "2026-09-14T04:42:00.000Z", result: "LOSS", pnl: "-60" },
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: /20 Aug: \$180\.00, 1 trades/i }));
    expect(screen.getByText("Thursday, 20 August 2026")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /next month/i, hidden: true }));
    expect(screen.queryByText("Thursday, 20 August 2026")).toBeNull();
    expect(document.querySelectorAll(".day-trade-row")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /14 Sept?: -\$60\.00, 1 trades/i }));
    expect(screen.getByText("Monday, 14 September 2026")).toBeTruthy();
    expect(document.querySelectorAll(".day-trade-row")).toHaveLength(1);
    expect(screen.queryByText("$180.00")).toBeNull();
  });

  it("labels MT5 tickets and open trades in the drill-down", () => {
    render(<PnlCalendarWithWeeks trades={[{ id: 8, tradeDate: "2026-08-20T06:00:00.000Z", result: "OPEN", pnl: "45.2", risk: "50", direction: "BUY", mt5Ticket: "98765" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /20 Aug: \$45\.20, 1 trades/i }));
    expect(screen.getByText(/MT5 #98765/)).toBeTruthy();
    expect(screen.getByText("unrealized")).toBeTruthy();
    expect(screen.queryByText("WIN")).toBeNull();
    expect(screen.queryByText("LOSS")).toBeNull();
  });

  it("reuses the journal editor for a trade opened from the calendar", () => {
    const onEdit = vi.fn();
    render(<PnlCalendarWithWeeks onEdit={onEdit} trades={[{ id: 42, tradeDate: "2026-08-20T04:42:00.000Z", result: "WIN", pnl: "180", direction: "BUY" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /20 Aug: \$180\.00, 1 trades/i }));
    fireEvent.click(screen.getByLabelText("Edit WIN trade"));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }));
  });

  it("closes on the close button and on Escape without touching journal data", () => {
    const trades = [
      { id: 1, tradeDate: "2026-08-20T04:42:00.000Z", result: "WIN", pnl: "180", direction: "BUY" },
      { id: 2, tradeDate: "2026-08-20T06:10:00.000Z", result: "LOSS", pnl: "-40", direction: "SELL" },
    ];
    const before = JSON.stringify(trades);
    render(<PnlCalendarWithWeeks trades={trades} />);
    const day = screen.getByRole("button", { name: /20 Aug: \$140\.00, 2 trades/i });
    fireEvent.click(day);
    expect(document.querySelector(".day-trades-dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.querySelector(".day-trades-dialog")).toBeNull();
    expect(day.getAttribute("aria-pressed")).toBe("false");
    expect(day.className).not.toContain("selected");
    fireEvent.click(day);
    expect(document.querySelector(".day-trades-dialog")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.querySelector(".day-trades-dialog")).toBeNull();
    // Read-only drill-down: the trade records handed to the calendar are unchanged.
    expect(JSON.stringify(trades)).toBe(before);
  });

  it("re-opens a day and reflects refreshed trades without caching a stale summary", () => {
    const first = [{ id: 1, tradeDate: "2026-08-20T04:42:00.000Z", result: "WIN", pnl: "180", direction: "BUY" }];
    const { rerender } = render(<PnlCalendarWithWeeks trades={first} />);
    fireEvent.click(screen.getByRole("button", { name: /20 Aug: \$180\.00, 1 trades/i }));
    expect(document.querySelectorAll(".day-trade-row")).toHaveLength(1);
    const synced = [...first, { id: 2, tradeDate: "2026-08-20T07:00:00.000Z", result: "WIN", pnl: "45", direction: "SELL", mt5Ticket: "555" }];
    rerender(<PnlCalendarWithWeeks trades={synced} />);
    expect(document.querySelectorAll(".day-trade-row")).toHaveLength(2);
    expect(screen.getByText(/MT5 #555/)).toBeTruthy();
    expect(screen.getAllByText("$225.00").length).toBeGreaterThan(0);
  });

  it("shows an open trade's trades on the Pakistan-local side of the midnight boundary", () => {
    render(<PnlCalendarWithWeeks trades={[
      { id: 1, tradeDate: "2026-08-03T18:59:00.000Z", result: "WIN", pnl: "10" }, // 03 Aug 23:59 PKT
      { id: 2, tradeDate: "2026-08-03T19:00:00.000Z", result: "LOSS", pnl: "-5" }, // 04 Aug 00:00 PKT
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: /03 Aug: \$10\.00, 1 trades/i }));
    expect(document.querySelectorAll(".day-trade-row")).toHaveLength(1);
    expect(screen.getAllByText("$10.00").length).toBeGreaterThan(0);
    cleanup();
    render(<PnlCalendarWithWeeks trades={[{ id: 2, tradeDate: "2026-08-03T19:00:00.000Z", result: "LOSS", pnl: "-5" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /04 Aug: -\$5\.00, 1 trades/i }));
    expect(screen.getByText("Tuesday, 4 August 2026")).toBeTruthy();
    expect(document.querySelectorAll(".day-trade-row")).toHaveLength(1);
  });
});
