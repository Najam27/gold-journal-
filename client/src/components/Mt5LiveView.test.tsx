/** @vitest-environment jsdom */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  create: vi.fn(),
  replace: vi.fn(),
  setActive: vi.fn(),
  updateOffset: vi.fn(),
  remove: vi.fn(),
  refetch: vi.fn(),
  workspaceData: undefined as any,
  historyData: undefined as any,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    mt5: {
      workspace: {
        useQuery: () => ({
          data: mocks.workspaceData ?? {
            connections: [{ id: 1, accountId: 12, accountName: "GFT 10K", label: "GFT Live", apiKey: "mt5_secret_connection_key_abcdefghijk", active: true, brokerUtcOffsetMinutes: 180, lastPing: new Date(), mt5Login: "90123456", brokerServer: "Broker-Live", currency: "USD", balance: "10000.00", equity: "10042.50", margin: "250.00", freeMargin: "9792.50", floatingPnl: "42.50", lastHistorySync: new Date(), historySyncedCount: 6 }],
            openPositions: [{ ticket: "123456789", symbol: "XAUUSD", direction: "BUY", lots: "0.01", openPrice: "3285.50", slPrice: "3275.00", tpPrice: "3310.00", riskUsd: "45.00", rewardUsd: "200.00", rrRatio: "4.44", floatingPnl: "12.50", openTime: new Date(), status: "OPEN" }],
            closedPositions: [{ ticket: "987654321", symbol: "XAUUSD", direction: "SELL", lots: "0.01", openPrice: "3300.00", closePrice: "3280.00", riskUsd: "50.00", rewardUsd: "100.00", rrRatio: "2.00", realizedPnl: "40.00", result: "WIN", closeTime: new Date(), journaled: false }],
          },
          isFetching: false,
          refetch: mocks.refetch,
        }),
      },
      history: {
        useQuery: () => ({
          data: mocks.historyData ?? { positions: [{ ticket: "987654321", symbol: "XAUUSD", direction: "SELL", lots: "0.01", openPrice: "3300.00", closePrice: "3280.00", riskUsd: "50.00", rewardUsd: "100.00", rrRatio: "2.00", realizedPnl: "40.00", result: "WIN", closeTime: new Date(), journaled: false }], total: 42, page: 1, pageSize: 20, pageCount: 3 },
          isFetching: false, isLoading: false, refetch: mocks.refetch,
        }),
      },
      integrity: { useQuery: () => ({ data: { health: { label: "Live MT5 sync" }, findings: [] }, isFetching: false }) },
      createConnection: { useMutation: () => ({ mutateAsync: mocks.create, isPending: false }) },
      replaceConnection: { useMutation: () => ({ mutateAsync: mocks.replace, isPending: false }) },
      updateConnectionOffset: { useMutation: () => ({ mutateAsync: mocks.updateOffset }) },
      setConnectionActive: { useMutation: () => ({ mutateAsync: mocks.setActive }) },
      deleteConnection: { useMutation: () => ({ mutateAsync: mocks.remove }) },
    },
    useUtils: () => ({ mt5: { workspace: { invalidate: mocks.invalidate }, history: { invalidate: mocks.invalidate } } }),
  },
}));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: ({ children }: any) => <>{children}</>, DialogContent: ({ children }: any) => <div>{children}</div>, DialogDescription: ({ children }: any) => <p>{children}</p>, DialogHeader: ({ children }: any) => <header>{children}</header>, DialogTitle: ({ children }: any) => <h2>{children}</h2> }));

import { Mt5LiveView } from "./Mt5LiveView";

describe("Mt5LiveView", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(value => {
      if (typeof value === "function" && "mockReset" in value) value.mockReset();
    });
    mocks.workspaceData = undefined;
    mocks.historyData = undefined;
    mocks.replace.mockResolvedValue({ id: 44, apiKey: "mt5_live_replacement_key_1234567890" });
  });

  it("shows masked credentials, account metrics, historical positions, EA v2.4, and automatic Trade Log synchronization", () => {
    const onJournalNow = vi.fn();
    render(<Mt5LiveView account={{ id: 12, name: "GFT 10K" }} accounts={[{ id: 12, name: "GFT 10K" }, { id: 13, name: "FundingPips" }]} onJournalNow={onJournalNow} />);
    expect(screen.getByText("GFT Live")).toBeTruthy();
    expect(screen.queryByText("mt5_secret_connection_key_abcdefghijk")).toBeNull();
    expect(screen.getAllByText("XAUUSD")).toHaveLength(2);
    expect(screen.getByText("$12.50")).toBeTruthy();
    expect(screen.getByText("$10,000.00")).toBeTruthy();
    expect(screen.getByText("$10,042.50")).toBeTruthy();
    expect(screen.getByText(/42 closed positions synced/i)).toBeTruthy();
    expect(screen.getByText(/Live refresh every 2\.5s/i)).toBeTruthy();
    expect(screen.getByText(/SETUP GUIDE · EA v2\.4/i)).toBeTruthy();
    const ea = screen.getByRole("link", { name: /Download EA/i });
    expect(ea.getAttribute("href")).toBe("/GoldJournal_EA.mq5");
    expect(screen.getByRole("columnheader", { name: "Trade Log" })).toBeTruthy();
    expect(screen.getByText("Syncing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Journal now" })).toBeNull();
    expect((screen.getByRole("combobox", { name: /Broker UTC offset for GFT Live/i }) as HTMLSelectElement).value).toBe("180");
    expect(onJournalNow).not.toHaveBeenCalled();
  });

  it("generates a replacement key directly when MT5 history exists but the connection record is missing", async () => {
    mocks.workspaceData = {
      connections: [],
      openPositions: [],
      closedPositions: [{ ticket: "987654321", symbol: "XAUUSD", direction: "SELL", lots: "0.01", openPrice: "3300.00", closePrice: "3280.00", riskUsd: "50.00", rewardUsd: "100.00", rrRatio: "2.00", realizedPnl: "40.00", result: "WIN", closeTime: new Date(), journaled: true }],
    };
    mocks.historyData = { positions: mocks.workspaceData.closedPositions, total: 1, page: 1, pageSize: 20, pageCount: 1 };

    render(<Mt5LiveView account={{ id: 12, name: "GFT 10K" }} accounts={[{ id: 12, name: "GFT 10K" }]} onJournalNow={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Reconnect GFT 10K/i }));

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith({ accountId: 12, label: "GFT 10K Live", brokerUtcOffsetMinutes: 180 }));
    await waitFor(() => expect(screen.getByText("mt5_live_replacement_key_1234567890")).toBeTruthy());
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
