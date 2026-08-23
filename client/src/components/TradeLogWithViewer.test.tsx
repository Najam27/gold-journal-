// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const imageMocks = vi.hoisted(() => ({ create: vi.fn(), copy: vi.fn(), download: vi.fn(), share: vi.fn() }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: ({ children }: any) => <>{children}</>, DialogContent: ({ children }: any) => <div>{children}</div>, DialogDescription: ({ children }: any) => <p>{children}</p>, DialogHeader: ({ children }: any) => <header>{children}</header>, DialogTitle: ({ children }: any) => <h2>{children}</h2> }));
vi.mock("@/lib/tradeCardPng", () => ({ createTradeCardPng: imageMocks.create, copyTradeCardPng: imageMocks.copy, downloadTradeCardPng: imageMocks.download, shareTradeCardPng: imageMocks.share }));

import { TradeLogWithViewer } from "./TradeLogWithViewer";

afterEach(() => cleanup());
beforeEach(() => Object.values(imageMocks).forEach(mock => mock.mockReset()));

describe("TradeLogWithViewer", () => {
  it("opens a card with trading detail and screenshot evidence without exposing internal metadata", () => {
    const trade = { id: 8, userId: 21, accountId: 3, createdAt: new Date("2026-08-12T12:00:00Z"), updatedAt: new Date("2026-08-12T12:30:00Z"), tradeDate: new Date("2026-08-12T12:00:00Z"), session: "London", direction: "BUY", result: "WIN", level: "RBS/TJL1", timeframe: "15m", setupQuality: "A", confirmationType: "BOS", executionType: "Manual Direct", marketCondition: "Bullish", biasAlignment: "Aligned", slPlacement: "Below swing", tpPlacement: "Prior high", mistake: "None", holdQuality: "Good", patienceScore: 4, risk: "20", reward: "105", pnl: "100", emotionBefore: "Calm", emotionDuring: "Focused", emotionAfter: "Disciplined", notes: "Waited for confirmation", screenshotKey: "gold-journal/21/trades/8.png", screenshotName: "entry.png", screenshotUrl: "https://example.test/trade.png" };
    render(<TradeLogWithViewer stats={{ balance: 100, winRate: 100, wins: 1, losses: 0, pnl: 100, total: 1 }} trades={[trade]} allTrades={[trade]} pagination={{ page: 1, pageSize: 12, total: 1, pageCount: 1 }} listLoading={false} account={{ name: "Primary" }} dangerGoals={[]} search="" resultFilter="ALL" setSearch={vi.fn()} setResultFilter={vi.fn()} onPage={vi.fn()} onNew={vi.fn()} onDuplicate={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onCash={vi.fn()} onCsv={vi.fn()} onExcel={vi.fn()} onPdf={vi.fn()} onClear={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/View trade from/i));
    expect(screen.getByText("Trade card")).toBeTruthy();
    expect(screen.getByText("Waited for confirmation")).toBeTruthy();
    expect(screen.getAllByText("Aligned").length).toBeGreaterThan(1);
    expect(screen.getByText("Below swing")).toBeTruthy();
    expect(screen.getByText("Good")).toBeTruthy();
    ["Journal entry ID", "Account ID", "Owner ID", "Screenshot file", "Screenshot key", "Saved", "Last updated", "gold-journal/21/trades/8.png", "entry.png"].forEach(value => expect(screen.queryByText(value)).toBeNull());
    expect(screen.getByAltText(/Trade screenshot/i)).toBeTruthy();
  });

  it("shows broker account metrics and confirms that active MT5 positions are logged automatically", () => {
    render(<TradeLogWithViewer stats={{ balance: 5000, winRate: 0, wins: 0, losses: 0, pnl: 0, total: 0 }} trades={[]} allTrades={[]} pagination={{ page: 1, pageSize: 12, total: 0, pageCount: 1 }} listLoading={false} account={{ name: "Primary" }} dangerGoals={[]} hasMt5Connection mt5Syncing mt5Summary={{ balance: "5120.50", equity: "5168.25", floatingPnl: "47.75", currency: "USD" }} mt5LivePositions={[{ ticket: "91001", symbol: "XAUUSD", direction: "BUY", floatingPnl: "47.75" }]} search="" resultFilter="ALL" setSearch={vi.fn()} setResultFilter={vi.fn()} onPage={vi.fn()} onNew={vi.fn()} onDuplicate={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onCash={vi.fn()} onCsv={vi.fn()} onExcel={vi.fn()} onPdf={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByText("MT5 balance")).toBeTruthy();
    expect(screen.getByText("MT5 equity")).toBeTruthy();
    expect(screen.getByText("MT5 floating P&L")).toBeTruthy();
    expect(screen.getByText("Synchronizing Trade Log…")).toBeTruthy();
    expect(screen.getByText("Logged automatically · updates with MT5")).toBeTruthy();
    expect(screen.getByText("XAUUSD")).toBeTruthy();
    expect(screen.queryByText("Journal balance")).toBeNull();
    expect(screen.queryByRole("button", { name: "Deposit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("keeps the connected broker balance in the summary and labels it as current only in the trade card", () => {
    const trade = { id: 12, tradeDate: new Date("2026-08-13T09:06:21Z"), session: "Post-London", direction: "SELL", result: "WIN", level: "", timeframe: "", setupQuality: "", confirmationType: "", executionType: "", marketCondition: "", biasAlignment: "", slPlacement: "", tpPlacement: "", mistake: "", holdQuality: "", risk: "0.88", reward: "2.56", pnl: "0.65", emotionBefore: "", emotionDuring: "", emotionAfter: "", notes: "" };
    render(<TradeLogWithViewer stats={{ balance: 5000, winRate: 100, wins: 1, losses: 0, pnl: 0.65, total: 1 }} trades={[trade]} allTrades={[trade]} pagination={{ page: 1, pageSize: 12, total: 1, pageCount: 1 }} listLoading={false} account={{ name: "Primary" }} dangerGoals={[]} hasMt5Connection mt5Summary={{ balance: "4888.25", equity: "4888.25", floatingPnl: "0", currency: "USD" }} mt5LivePositions={[]} search="" resultFilter="ALL" setSearch={vi.fn()} setResultFilter={vi.fn()} onPage={vi.fn()} onNew={vi.fn()} onDuplicate={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onCash={vi.fn()} onCsv={vi.fn()} onExcel={vi.fn()} onPdf={vi.fn()} onClear={vi.fn()} />);
    expect(screen.queryByRole("columnheader", { name: "MT5 balance" })).toBeNull();
    expect(screen.getByText("MT5 balance")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/View trade from/i));
    expect(screen.queryByText("Running balance")).toBeNull();
    expect(screen.getByText("Current MT5 balance")).toBeTruthy();
  });

  it("offers per-trade PNG download and falls back to download when image copy and browser sharing are unavailable", async () => {
    const trade = { id: 24, tradeDate: new Date("2026-08-13T09:06:21Z"), session: "London", direction: "BUY", result: "WIN", risk: "20", reward: "40", pnl: "35" };
    imageMocks.create.mockResolvedValue({ blob: new Blob(["png"], { type: "image/png" }), filename: "trade.png" });
    imageMocks.copy.mockResolvedValue(false);
    imageMocks.share.mockResolvedValue(false);
    render(<TradeLogWithViewer stats={{ balance: 5000, winRate: 100, wins: 1, losses: 0, pnl: 35, total: 1 }} trades={[trade]} allTrades={[trade]} pagination={{ page: 1, pageSize: 12, total: 1, pageCount: 1 }} listLoading={false} account={{ name: "Primary" }} dangerGoals={[]} search="" resultFilter="ALL" setSearch={vi.fn()} setResultFilter={vi.fn()} onPage={vi.fn()} onNew={vi.fn()} onDuplicate={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onCash={vi.fn()} onCsv={vi.fn()} onExcel={vi.fn()} onPdf={vi.fn()} onClear={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/Download trade card PNG from/i));
    await vi.waitFor(() => expect(imageMocks.download).toHaveBeenCalledWith(expect.any(Blob), "trade.png"));
    fireEvent.click(screen.getByLabelText(/Share trade card from/i));
    await vi.waitFor(() => expect(imageMocks.copy).toHaveBeenCalled());
    await vi.waitFor(() => expect(imageMocks.share).toHaveBeenCalled());
    expect(imageMocks.download).toHaveBeenCalledTimes(2);
  });

  it("copies the generated PNG before opening a native share fallback", async () => {
    const trade = { id: 25, tradeDate: new Date("2026-08-13T09:06:21Z"), session: "London", direction: "BUY", result: "WIN", risk: "20", reward: "40", pnl: "35" };
    imageMocks.create.mockResolvedValue({ blob: new Blob(["png"], { type: "image/png" }), filename: "trade.png" });
    imageMocks.copy.mockResolvedValue(true);
    render(<TradeLogWithViewer stats={{ balance: 5000, winRate: 100, wins: 1, losses: 0, pnl: 35, total: 1 }} trades={[trade]} allTrades={[trade]} pagination={{ page: 1, pageSize: 12, total: 1, pageCount: 1 }} listLoading={false} account={{ name: "Primary" }} dangerGoals={[]} search="" resultFilter="ALL" setSearch={vi.fn()} setResultFilter={vi.fn()} onPage={vi.fn()} onNew={vi.fn()} onDuplicate={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onCash={vi.fn()} onCsv={vi.fn()} onExcel={vi.fn()} onPdf={vi.fn()} onClear={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/Share trade card from/i));
    await vi.waitFor(() => expect(imageMocks.copy).toHaveBeenCalled());
    expect(imageMocks.share).not.toHaveBeenCalled();
    expect(imageMocks.download).not.toHaveBeenCalled();
  });
});
