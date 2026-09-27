/** @vitest-environment jsdom */
import React from "react";
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { GuardBanner } from "./GuardBanner";
import type { GuardConfig } from "@/lib/guardMode";

afterEach(cleanup);

const fundedConfig = (overrides = {}): GuardConfig => ({
  enabled: false,
  accountSize: null,
  dailyLossLimit: null,
  maxDrawdownLimit: null,
  maxTradesPerDay: null,
  funded: {
    enabled: true,
    accountSize: 100000,
    sizeMode: "manual",
    dailyDrawdownPct: 5,
    maxDrawdownPct: 10,
    drawdownType: "static",
    dayStartOverride: "",
    peakEquity: "",
    mt5Balance: null,
    mt5Equity: null,
    snapshotAt: null,
    startingBalanceOverride: "",
    ...overrides,
  },
});

describe("GuardBanner (funded guard)", () => {
  it("stays silent when the funded guard is not configured", () => {
    const { container } = render(
      <GuardBanner guardConfig={null} trades={[]} startingBalance={100000} />,
    );
    expect(container.querySelector(".guard-banner")).toBeNull();
  });

  it("stays silent when today's loss is small", () => {
    const { container } = render(
      <GuardBanner
        guardConfig={fundedConfig()}
        trades={[{ tradeDate: new Date().toISOString(), pnl: -500, result: "LOSS" }]}
        startingBalance={100000}
      />,
    );
    expect(container.querySelector(".guard-banner")).toBeNull();
  });

  it("warns when today's loss approaches the daily limit", () => {
    // 5% of $100,000 = $5,000 daily limit; -$4,600 = 92% used (danger).
    render(
      <GuardBanner
        guardConfig={fundedConfig()}
        trades={[{ tradeDate: new Date().toISOString(), pnl: -4600, result: "LOSS" }]}
        startingBalance={100000}
      />,
    );
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/daily limit almost gone/i)).toBeDefined();
  });

  it("breaches when today's loss exceeds the daily limit", () => {
    render(
      <GuardBanner
        guardConfig={fundedConfig()}
        trades={[{ tradeDate: new Date().toISOString(), pnl: -6000, result: "LOSS" }]}
        startingBalance={100000}
      />,
    );
    expect(screen.getByText(/stop trading/i)).toBeDefined();
  });

  it("derives day-start equity from all-time P&L minus today P&L", () => {
    // Starting $100k, +$10k all-time, -$4k today → day-start $106k,
    // daily limit $5,300, usage $4k = 75% → caution.
    render(
      <GuardBanner
        guardConfig={fundedConfig()}
        trades={[
          { tradeDate: new Date(Date.now() - 86_400_000).toISOString(), pnl: 14000, result: "WIN" },
          { tradeDate: new Date().toISOString(), pnl: -4000, result: "LOSS" },
        ]}
        startingBalance={100000}
      />,
    );
    expect(screen.getByRole("alert")).toBeDefined();
  });
});
