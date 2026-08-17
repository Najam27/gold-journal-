// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock("@/lib/accountSelection", () => ({ getSelectedAccountId: () => 3, subscribeSelectedAccount: () => () => {} }));
vi.mock("@/lib/trpc", () => ({ trpc: { useUtils: () => ({ trades: { list: { fetch: vi.fn() } } }), journal: { get: { useQuery: () => ({ data: { activeAccount: { id: 3, name: "Funded Gold" }, trades: [{ id: 1, accountId: 3, tradeDate: new Date("2026-08-02T12:00:00Z"), pnl: "12", result: "WIN" }, { id: 2, accountId: 9, tradeDate: new Date("2026-08-03T12:00:00Z"), pnl: "99", result: "WIN" }] } }) } } } }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: ({ children }: any) => <>{children}</>, DialogContent: ({ children }: any) => <div>{children}</div>, DialogDescription: ({ children }: any) => <p>{children}</p>, DialogHeader: ({ children }: any) => <div>{children}</div>, DialogTitle: ({ children }: any) => <h2>{children}</h2> }));

import { BulkPdfExporter, pdfTradeCardFields } from "./BulkPdfExporter";

describe("BulkPdfExporter", () => {
  afterEach(() => cleanup());

  it("opens from the trade-log action and retains active-account-only selections across a custom range", async () => {
    render(<BulkPdfExporter />);
    window.dispatchEvent(new Event("gold-journal:bulk-pdf"));
    await waitFor(() => expect(screen.getByText("Bulk trade-log PDF")).toBeTruthy());
    expect(document.querySelector(".pdf-selection-summary")?.textContent).toContain("1 recent preview trade");
    fireEvent.click(screen.getByRole("button", { name: /Custom date range/i }));
    expect(screen.getByLabelText("From")).toBeTruthy();
    expect(screen.getByLabelText("To")).toBeTruthy();
  });

  it("allows only trader-facing execution fields into every exported trade card", () => {
    const fields = pdfTradeCardFields({ id: 7, userId: 21, accountId: 3, screenshotKey: "gold-journal/21/trades/7.png", screenshotName: "private-entry.png", createdAt: new Date(), updatedAt: new Date(), session: "London", level: "RBS", timeframe: "15m", setupQuality: "A", risk: 20, reward: 80, pnl: 60 });
    expect(fields.map(([label]) => label)).toEqual(["Session", "Level", "Timeframe", "Setup", "Risk", "Reward", "R:R", "P&L"]);
    expect(JSON.stringify(fields)).not.toContain("gold-journal/");
    expect(JSON.stringify(fields)).not.toContain("private-entry.png");
  });
});
