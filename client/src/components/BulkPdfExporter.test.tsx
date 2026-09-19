// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchPage = vi.fn(async () => ({
  trades: [
    { id: 1, accountId: 3, tradeDate: new Date("2026-08-02T12:00:00Z"), pnl: "12", result: "WIN", session: "London", direction: "BUY", level: "RBS", setupQuality: "A", notes: "Waited for the retest", emotionBefore: "calm", mt5Ticket: "987654", hasScreenshot: true, screenshotName: "london.png", screenshotUrl: "https://files.test/london.png" },
    { id: 2, accountId: 9, tradeDate: new Date("2026-08-03T12:00:00Z"), pnl: "99", result: "WIN", notes: "OTHER ACCOUNT" },
  ],
  total: 1,
  page: 1,
  pageSize: 50,
  pageCount: 1,
}));

const pdfInstances: any[] = [];
vi.mock("jspdf", () => ({
  jsPDF: class {
    texts: string[] = [];
    images = 0;
    pages = 1;
    savedAs: string | null = null;
    constructor() { pdfInstances.push(this); }
    addPage() { this.pages += 1; return this; }
    getNumberOfPages() { return this.pages; }
    setFillColor() { return this; }
    setTextColor() { return this; }
    setFontSize() { return this; }
    rect() { return this; }
    roundedRect() { return this; }
    addImage() { this.images += 1; return this; }
    getImageProperties() { return { width: 1200, height: 700 }; }
    setPage() { return this; }
    setFont() { return this; }
    text(value: string | string[]) { this.texts.push(...(Array.isArray(value) ? value : [value])); return this; }
    splitTextToSize(text: string) { return [text]; }
    save(filename: string) { this.savedAs = filename; }
  },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock("@/lib/accountSelection", () => ({ getSelectedAccountId: () => 3, subscribeSelectedAccount: () => () => {} }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ trades: { list: { fetch: fetchPage } } }),
    journal: {
      get: {
        useQuery: () => ({
          data: {
            activeAccount: { id: 3, name: "Funded Gold", startingBalance: "1000.00" },
            cashNet: 0,
            trades: [
              { id: 1, accountId: 3, tradeDate: new Date("2026-08-02T12:00:00Z"), pnl: "12", result: "WIN" },
              { id: 2, accountId: 9, tradeDate: new Date("2026-08-03T12:00:00Z"), pnl: "99", result: "WIN" },
            ],
          },
        }),
      },
    },
  },
}));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: ({ children }: any) => <>{children}</>, DialogContent: ({ children }: any) => <div>{children}</div>, DialogDescription: ({ children }: any) => <p>{children}</p>, DialogHeader: ({ children }: any) => <div>{children}</div>, DialogTitle: ({ children }: any) => <h2>{children}</h2> }));

import { BulkPdfExporter } from "./BulkPdfExporter";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("BulkPdfExporter", () => {
  afterEach(() => { cleanup(); pdfInstances.length = 0; fetchPage.mockClear(); vi.unstubAllGlobals(); });

  it("opens from the trade-log action and retains active-account-only selections across a custom range", async () => {
    render(<BulkPdfExporter />);
    window.dispatchEvent(new Event("gold-journal:bulk-pdf"));
    await waitFor(() => expect(screen.getByText("Trade-log PDF report")).toBeTruthy());
    expect(document.querySelector(".pdf-selection-summary")?.textContent).toContain("1 recent preview trade");
    fireEvent.click(screen.getByRole("button", { name: /Custom date range/i }));
    expect(screen.getByLabelText("From")).toBeTruthy();
    expect(screen.getByLabelText("To")).toBeTruthy();
  });

  it("exports every page for the selected account and writes the complete trade card model into the PDF", async () => {
    const png = Uint8Array.from(atob(PNG_1PX), character => character.charCodeAt(0));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } })));
    render(<BulkPdfExporter />);
    window.dispatchEvent(new Event("gold-journal:bulk-pdf"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Download PDF report/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Download PDF report/i }));
    await waitFor(() => expect(pdfInstances.length).toBe(1));

    expect(fetchPage).toHaveBeenCalledWith({ accountId: 3, page: 1, pageSize: 50, search: "" });
    const doc = pdfInstances[0];
    await waitFor(() => expect(doc.savedAs).toContain("Funded-Gold"));
    const written = doc.texts.join("\n");
    // The complete canonical model reaches the document, not a hand-picked subset.
    ["TRADE ID", "MT5 TICKET", "SETUP QUALITY", "CONFIRMATION", "PLANNED R:R", "ACTUAL P&L", "RUNNING BALANCE", "PRE-TRADE CHECKLIST", "JOURNAL NOTE", "BEFORE TRADE", "SCREENSHOT EVIDENCE"].forEach(label => expect(written).toContain(label));
    expect(written).toContain("#987654");
    expect(written).toContain("Waited for the retest");
    expect(written).toContain("calm");
    expect(written).toContain("london.png");
    expect(doc.images).toBe(1);
    // Only the selected account is exported, even though the fetch returned another account's row.
    expect(written).not.toContain("OTHER ACCOUNT");
  });
});
