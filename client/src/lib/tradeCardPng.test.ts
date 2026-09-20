import { describe, expect, it } from "vitest";
import { copyTradeCardPng, publicTradeCardFields, tradeCardPngFilename } from "./tradeCardPng";
import { TRADE_PRESENTATION_LABELS, buildTradePresentation } from "./tradePresentation";

const trade = {
  id: 8,
  userId: 21,
  accountId: 3,
  tradeDate: "2026-08-12T12:00:00.000Z",
  session: "London",
  direction: "BUY",
  result: "WIN",
  risk: "20",
  reward: "105",
  pnl: "100",
  level: "RBS",
  mistake: "Impatience",
  notes: "Waited for confirmation",
  planStatus: "PLANNED",
  screenshotKey: "gold-journal/21/trades/8.png",
  screenshotName: "private-chart.png",
  screenshotUrl: "https://private.example/signed",
  mt5Ticket: "99887766",
};

describe("share trade card contract", () => {
  it("shares the same canonical field set as View Trade and the PDF", () => {
    const shared = publicTradeCardFields(trade);
    const canon = buildTradePresentation(trade);
    const canonical = canon.sections.flatMap(section => section.fields).map(field => [field.label, field.value]);
    expect(shared).toEqual(canonical);
    // Every label the edit form/PDF print is on the card too.
    TRADE_PRESENTATION_LABELS.forEach(label => expect(shared.map(([entry]) => entry)).toContain(label));
  });

  it("includes the recorded trade values and excludes internal ownership, storage, and sync metadata", () => {
    const serialized = JSON.stringify(publicTradeCardFields(trade));
    ["London", "RBS", "Waited for confirmation", "Impatience"].forEach(value => expect(serialized).toContain(value));
    ["accountId", "userId", "screenshotKey", "screenshotName", "private-chart", "screenshotUrl", "gold-journal", "private.example", "21/trades", "mt5Ticket", "99887766"]
      .forEach(value => expect(serialized).not.toContain(value));
  });

  it("creates a safe descriptive PNG filename without internal ids", () => {
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
