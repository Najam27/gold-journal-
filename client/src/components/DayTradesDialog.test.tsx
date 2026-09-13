// @vitest-environment jsdom
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The dialog primitives are mocked the same way the trade dialog test mocks them:
// content renders inline so the drill-down data can be asserted directly.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: any) => (open ? <>{children}</> : null),
  DialogContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogHeader: ({ children, ...props }: any) => <header {...props}>{children}</header>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  DialogDescription: ({ children, ...props }: any) => <p {...props}>{children}</p>,
}));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));

import { DayTradesDialog } from "./DayTradesDialog";
import { summarizeDayTrades } from "@/lib/performanceSummary";

const trades = [
  { id: 1, tradeDate: "2026-08-20T04:42:00.000Z", result: "WIN", pnl: "180", risk: "100", reward: "200", session: "London", direction: "BUY" },
  { id: 2, tradeDate: "2026-08-20T06:10:00.000Z", result: "LOSS", pnl: "-40", risk: "100", reward: "200", session: "London", direction: "SELL", mt5Ticket: "123456" },
  { id: 3, tradeDate: "2026-08-20T09:20:00.000Z", result: "WIN", pnl: "95", risk: "50", reward: "150", session: "New York", direction: "BUY" },
  { id: 4, tradeDate: "2026-08-20T12:05:00.000Z", result: "WIN", pnl: "105", risk: "50", reward: "150", session: "New York", direction: "SELL", localPending: true },
];

const renderDay = (day: string | null, rows: any[] = trades, onEdit?: (trade: any) => void) =>
  render(<DayTradesDialog day={day} summary={day ? summarizeDayTrades(rows, day) : null} onOpenChange={vi.fn()} onEdit={onEdit} />);

afterEach(() => cleanup());

describe("DayTradesDialog", () => {
  it("does not open for a day without trades", () => {
    renderDay("2026-08-19");
    expect(screen.queryByText(/DAILY PERFORMANCE/)).toBeNull();
    expect(screen.queryByText(/Daily P&L/)).toBeNull();
  });

  it("shows the exact Pakistan-local date and the shared daily totals", () => {
    renderDay("2026-08-20");
    expect(screen.getByText("Thursday, 20 August 2026")).toBeTruthy();
    expect(screen.getByText("Daily P&L")).toBeTruthy();
    expect(screen.getAllByText("$340.00").length).toBeGreaterThan(0);
    const summary = screen.getByText("Wins").parentElement as HTMLElement;
    expect(within(summary).getByText("3")).toBeTruthy();
    expect(within(screen.getByText("Losses").parentElement as HTMLElement).getByText("1")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText(/4 trades recorded/)).toBeTruthy();
  });

  it("lists every trade of the day with direction, result, and P&L", () => {
    renderDay("2026-08-20");
    const rows = document.querySelectorAll(".day-trade-row");
    expect(rows.length).toBe(4);
    expect(rows[0].textContent).toContain("$180.00");
    expect(rows[1].textContent).toContain("-$40.00");
    expect(rows[2].textContent).toContain("$95.00");
    expect(rows[3].textContent).toContain("$105.00");
    expect(screen.getByText("London · 09:42")).toBeTruthy();
    expect(screen.getAllByText("WIN").length).toBe(3);
    expect(screen.getAllByText("LOSS").length).toBe(1);
  });

  it("never shows a trade from another day", () => {
    renderDay("2026-08-21");
    expect(document.querySelectorAll(".day-trade-row").length).toBe(0);
  });

  it("renders a losing day as a negative drill-down without inventing wins", () => {
    render(<DayTradesDialog day="2026-08-21" summary={summarizeDayTrades([{ id: 9, tradeDate: "2026-08-21T06:00:00.000Z", result: "LOSS", pnl: "-125", risk: "125" }], "2026-08-21")} onOpenChange={vi.fn()} />);
    expect(screen.getAllByText("-$125.00").length).toBe(3);
    expect(screen.getByText("Losing day")).toBeTruthy();
    expect(screen.getByText("0%")).toBeTruthy();
  });

  it("labels an open trade as unrealized instead of a win or a loss", () => {
    render(<DayTradesDialog day="2026-08-20" summary={summarizeDayTrades([{ id: 7, tradeDate: "2026-08-20T06:00:00.000Z", result: "OPEN", pnl: "45.2", risk: "50" }], "2026-08-20")} onOpenChange={vi.fn()} />);
    expect(screen.getAllByText("OPEN").length).toBeGreaterThan(0);
    expect(screen.getByText("unrealized")).toBeTruthy();
    expect(screen.getAllByText("$45.20").length).toBe(4);
    expect(screen.queryByText("WIN")).toBeNull();
    expect(screen.queryByText("LOSS")).toBeNull();
    expect(screen.getByText("0%")).toBeTruthy();
  });

  it("shows the MT5 ticket only when the trade carries one", () => {
    renderDay("2026-08-20");
    expect(screen.getByText(/MT5 #123456/)).toBeTruthy();
    expect(screen.getByLabelText(/View LOSS trade at 11:10/).textContent).toContain("MT5 #123456");
    // Only the one MT5 trade carries a ticket row.
    expect(document.querySelectorAll(".day-trade-body small")).toHaveLength(6);
  });

  it("keeps manual trades visible without an MT5 ticket row", () => {
    render(<DayTradesDialog day="2026-08-20" summary={summarizeDayTrades([{ id: 11, tradeDate: "2026-08-20T05:00:00.000Z", result: "WIN", pnl: "30", risk: "30", session: "Asian", direction: "BUY" }], "2026-08-20")} onOpenChange={vi.fn()} />);
    expect(screen.queryByText(/MT5 #/)).toBeNull();
    expect(document.querySelectorAll(".day-trade-row").length).toBe(1);
    expect(screen.getByText("Asian · 10:00")).toBeTruthy();
  });

  it("flags a locally saved trade that is still waiting to sync", () => {
    renderDay("2026-08-20");
    expect(screen.getByText("Pending sync")).toBeTruthy();
  });

  it("opens the existing trade viewer when a trade is clicked", () => {
    renderDay("2026-08-20");
    fireEvent.click(screen.getByLabelText(/View WIN trade at 14:20: \$95\.00/));
    expect(screen.getByText("Trade card")).toBeTruthy();
    expect(screen.getByText("Actual P&L")).toBeTruthy();
  });

  it("reuses the journal edit action for a specific trade", () => {
    const onEdit = vi.fn();
    renderDay("2026-08-20", trades, onEdit);
    fireEvent.click(screen.getByLabelText("Edit LOSS trade"));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("renders read-only: no edit action and no mutation when no editor is wired", () => {
    const onEdit = vi.fn();
    renderDay("2026-08-20");
    expect(screen.queryByRole("button", { name: /Edit .* trade/ })).toBeNull();
    fireEvent.click(screen.getByLabelText(/View WIN trade at 09:42: \$180\.00/));
    expect(onEdit).not.toHaveBeenCalled();
  });

  // The dialog ships its styles in the calendar stylesheet, so the contract test
  // reads that source rather than computed styles jsdom cannot resolve.
  const calendarCss = () => {
    const fromRoot = resolve(process.cwd(), "client/src/gold-overrides.css");
    const fromModule = import.meta.url.startsWith("file:") ? resolve(fileURLToPath(import.meta.url), "..", "..", "gold-overrides.css") : "";
    const path = [fromRoot, fromModule].find(candidate => candidate && existsSync(candidate));
    if (!path) throw new Error("gold-overrides.css was not found for the dialog style contract test.");
    return readFileSync(path, "utf8");
  };

  it("stays readable in dark mode by using theme tokens instead of fixed colors", () => {
    const css = calendarCss();
    const rules = css.slice(css.indexOf(".day-trades-dialog"));
    expect(rules).toContain("background: var(--gj-panel)");
    expect(rules).toContain("border-color: var(--gj-line)");
    expect(rules).toContain("background: var(--gj-panel-2)");
    expect(rules).toContain("color: var(--gj-text)");
    expect(rules).toContain("color: var(--gj-subtext)");
    expect(rules).not.toMatch(/#(?:fff|ffffff|000|000000|111|101010)\b/i);
    document.documentElement.classList.add("dark");
    try {
      renderDay("2026-08-20");
      const dialog = document.querySelector(".day-trades-dialog") as HTMLElement;
      expect(dialog.className).toContain("positive");
      expect(document.querySelectorAll(".day-trade-row")).toHaveLength(4);
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });

  it("stays usable on a phone-sized viewport", () => {
    const css = calendarCss();
    const mobile = css.slice(css.indexOf("@media (max-width: 640px)"));
    expect(mobile).toContain(".day-trades-dialog");
    expect(mobile).toContain("width: 100vw");
    expect(mobile).toContain(".day-trade-body");
    expect(css.slice(css.indexOf(".day-trade-list {")).split("@media")[0]).toContain("overflow-y: auto");
    expect(css).toContain("max-height: min(88dvh, 46rem)");
  });
});
