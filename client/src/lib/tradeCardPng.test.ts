import { describe, expect, it, vi } from "vitest";
import { copyTradeCardPng, publicTradeCardFields, tradeCardPngFilename } from "./tradeCardPng";

describe("trade card PNG contract", () => {
  const trade = { id: 8, userId: 21, accountId: 3, tradeDate: "2026-08-12T12:00:00.000Z", session: "London", direction: "BUY", result: "WIN", risk: "20", reward: "105", pnl: "100", level: "RBS", notes: "Waited for confirmation", screenshotKey: "gold-journal/21/trades/8.png", screenshotUrl: "https://private.example/signed" };

  it("includes only user-facing trade values and excludes internal ownership and storage fields", () => {
    const serialized = JSON.stringify(publicTradeCardFields(trade));
    expect(serialized).toContain("London");
    ["accountId", "userId", "screenshotKey", "screenshotUrl", "gold-journal", "private.example", "21/trades", "Waited for confirmation"].forEach(value => expect(serialized).not.toContain(value));
  });

  it("creates a safe descriptive PNG filename without internal IDs", () => {
    const filename = tradeCardPngFilename(trade);
    expect(filename).toMatch(/^GoldJournal_TradeCard_.*_buy_win\.png$/);
    expect(filename).not.toContain("private");
    expect(filename).not.toContain("gold-journal");
  });

  it("returns false when the browser does not expose an image clipboard API", async () => {
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    await expect(copyTradeCardPng(new Blob(["png"], { type: "image/png" }))).resolves.toBe(false);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  });
});
