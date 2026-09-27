/** @vitest-environment jsdom */
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FundedGuardPanel } from "./FundedGuardPanel";

vi.mock("@/lib/trpc", () => ({
  trpc: {
    journal: {
      get: {
        useQuery: () => ({
          data: {
            trades: [
              // Today (PKT) losing trade: -$2,500 realized
              { tradeDate: new Date().toISOString(), pnl: -2500, result: "LOSS" },
              // Yesterday: should not count toward today
              { tradeDate: new Date(Date.now() - 86_400_000).toISOString(), pnl: -9000, result: "LOSS" },
              // Open trade today: excluded (not realized)
              { tradeDate: new Date().toISOString(), pnl: 0, result: "OPEN" },
            ],
          },
          isLoading: false,
        }),
      },
    },
    mt5: {
      workspace: {
        useQuery: () => ({
          data: { account: { equity: 100000, balance: 100000 } },
          isLoading: false,
        }),
      },
    },
  },
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input {...props} />,
}));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("FundedGuardPanel", () => {
  it("auto-detects account size from live equity", () => {
    render(<FundedGuardPanel accountId={1} />);
    expect(screen.getByText(/Funded account guard/i)).toBeTruthy();
    // Mocked MT5 workspace returns $100,000 equity
    expect(screen.getByText("$100,000")).toBeTruthy();
  });

  it("computes FTMO-style limits from percentages", () => {
    render(<FundedGuardPanel accountId={1} />);
    // Day-start equity = $100k live + $2.5k lost today = $102,500.
    // 5% daily of $102,500 = $5,125 ; 10% static max of $100k = $10,000
    expect(screen.getByText("$5,125")).toBeTruthy();
    expect(screen.getByText("$10,000")).toBeTruthy();
  });

  it("shows today's usage from realized journal P&L", () => {
    render(<FundedGuardPanel accountId={1} />);
    // -$2,500 of $5,125 daily = 48.78% → 49%
    expect(screen.getByText("49%")).toBeTruthy();
  });

  it("allows manual account size entry", () => {
    render(<FundedGuardPanel accountId={1} />);
    fireEvent.click(screen.getByText("Manual"));
    fireEvent.change(screen.getByPlaceholderText(/100000/i), { target: { value: "50000" } });
    // Static max follows the manual size: 10% of $50k = $5,000.
    // Daily still uses the auto day-start ($102,500) → $5,125.
    expect(screen.getByText("$5,000")).toBeTruthy();
    expect(screen.getByText("$5,125")).toBeTruthy();
  });

  it("lets the trader override day-start equity", () => {
    render(<FundedGuardPanel accountId={1} />);
    const dayStart = screen.getByPlaceholderText(/Auto:/i);
    fireEvent.change(dayStart, { target: { value: "100000" } });
    // 5% daily of the overridden $100k = $5,000
    expect(screen.getByText("$5,000")).toBeTruthy();
  });

  it("caps per-trade risk at 30% of the daily allowance", () => {
    render(<FundedGuardPanel accountId={1} />);
    // 30% of $5,125 = $1,537.5
    expect(screen.getByText("$1,537.5")).toBeTruthy();
  });

  it("reveals peak equity input for trailing drawdown", () => {
    render(<FundedGuardPanel accountId={1} />);
    const select = screen.getByLabelText(/Max drawdown type/i);
    fireEvent.change(select, { target: { value: "trailing" } });
    expect(screen.getByPlaceholderText(/108000/i)).toBeTruthy();
  });
});
