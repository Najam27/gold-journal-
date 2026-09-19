import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeBulkPdfTrades } from "./bulkPdf";
import { PDF_PAGE, SCREENSHOT_EMBED_FAILURE, createPdfImageCache, detectImageFormat, fetchPdfImage, fitInside, renderTradeLogPdf, type PdfDoc, type PdfImage, type PdfTextOptions, type TradeLogPdfTrade } from "./tradePdfReport";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type TextCall = { text: string; x: number; y: number; size: number; page: number; align: string };
type ImageCall = { format: string; x: number; y: number; width: number; height: number; page: number; dataUrl: string };

/**
 * A jsPDF-shaped recorder for the A4 landscape report. It validates page bounds
 * the way the real writer must (text inside the page, images inside the page) so
 * a layout regression fails the test instead of silently clipping the document.
 */
class RecordingPdfDoc implements PdfDoc {
  texts: TextCall[] = [];
  images: ImageCall[] = [];
  violations: string[] = [];
  private page = 1;
  private fontSize = 10;
  private dimensions = new Map<string, { width: number; height: number }>();

  withDimensions(dataUrl: string, width: number, height: number) { this.dimensions.set(dataUrl, { width, height }); return this; }
  addPage() { this.page += 1; return this; }
  setPage(page: number) { this.page = page; return this; }
  getNumberOfPages() { return this.page; }
  setFillColor() { return this; }
  setTextColor() { return this; }
  setFontSize(size: number) { this.fontSize = size; return this; }
  setFont() { return this; }
  rect() { return this; }
  roundedRect() { return this; }
  text(value: string | string[], x: number, y: number, options?: PdfTextOptions) {
    const align = options?.align ?? "left";
    for (const line of Array.isArray(value) ? value : [value]) {
      this.texts.push({ text: line, x, y, size: this.fontSize, page: this.page, align });
      if (y < 0 || y > PDF_PAGE.height || x < 0 || x > PDF_PAGE.width) this.violations.push(`text out of bounds: ${line}`);
      // ≈0.18 mm per character per point is a realistic Helvetica width.
      if (align === "left" && x + line.length * this.fontSize * 0.18 > PDF_PAGE.width + 1) this.violations.push(`text overflows the page: ${line}`);
    }
    return this;
  }
  splitTextToSize(text: string, maxWidth: number) {
    const perLine = Math.max(6, Math.floor(maxWidth / (this.fontSize * 0.18)));
    const lines: string[] = [];
    let current = "";
    for (const word of String(text ?? "").split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > perLine && current) { lines.push(current); current = word; } else current = candidate;
    }
    if (current) lines.push(current);
    return lines.length ? lines : [""];
  }
  addImage(dataUrl: string, format: string, x: number, y: number, width: number, height: number) {
    this.images.push({ dataUrl, format, x, y, width, height, page: this.page });
    if (y < 0 || y + height > PDF_PAGE.height || x < 0 || x + width > PDF_PAGE.width) this.violations.push(`image out of bounds: ${format}`);
    return this;
  }
  getImageProperties(dataUrl: string) { return this.dimensions.get(dataUrl) ?? { width: 1600, height: 900 }; }
  written() { return this.texts.map(entry => entry.text).join("\n"); }
  /** Wrapping-insensitive view of the page text, for content assertions. */
  flattened() { return this.written().replace(/\s+/g, " "); }
  pageOf(text: string) { return this.texts.find(entry => entry.text === text)?.page ?? null; }
  pagesWithImage() { return Array.from(new Set(this.images.map(image => image.page))).sort((a, b) => a - b); }
  footerPages() { return Array.from(new Set(this.texts.filter(entry => entry.text.startsWith("Page ")).map(entry => entry.page))).sort((a, b) => a - b); }
}

const trade = (overrides: Record<string, unknown> = {}) => ({ id: 1, accountId: 3, tradeDate: "2026-08-04T09:00:00.000Z", pnl: "10.00", result: "WIN", session: "London", direction: "BUY", ...overrides });

/** A trade carrying every field the Trade Card can show. */
const completeTrade = (overrides: Record<string, unknown> = {}) => trade({
  id: 696, symbol: "XAUUSD", mt5Ticket: "17446150", timeframe: "15m", level: "H4 RBS + FVG", setupQuality: "A+",
  confirmationType: "Displacement + BOS", marketCondition: "Trending", biasAlignment: "Counter-trend", executionType: "Manual direct",
  slPlacement: "Above swing", tpPlacement: "R multiple", holdQuality: "Average", patienceScore: 4, mistake: "Impatience|Closed early|Entered without confirmation",
  risk: "10.00", reward: "93.30", pnl: "70.90", openTime: "2026-08-04T09:00:00.000Z", closeTime: "2026-08-04T09:04:00.000Z",
  mfe: "80.00", mae: "-6.00", emotionBefore: "Calm", emotionDuring: "Fear", emotionAfter: "Regret",
  planStatus: "PLANNED", planChecklist: "setup-exists|matches-plan|stop-defined|risk-in-limit|size-valid|rr-acceptable|session-valid|no-emotional-trigger|not-revenge",
  notes: "Waited for the retest, entered on displacement, managed the position into the weekly level.", ...overrides,
});

async function render(trades: TradeLogPdfTrade[], options: { fetchImage?: (url: string) => Promise<PdfImage>; accountName?: string; rangeLabel?: string; doc?: RecordingPdfDoc } = {}) {
  const doc = options.doc ?? new RecordingPdfDoc();
  await renderTradeLogPdf(doc, {
    accountName: options.accountName ?? "Funded Gold",
    rangeLabel: options.rangeLabel ?? "2026-08-01 to 2026-08-31",
    mode: "ALL_TIME",
    summary: summarizeBulkPdfTrades(trades.map(row => row.trade as never)),
    trades,
    fetchImage: options.fetchImage ?? (async () => ({ dataUrl: `data:image/png;base64,${PNG_1PX}`, format: "PNG" })),
  });
  return doc;
}

afterEach(() => vi.unstubAllGlobals());

describe("trade log PDF report layout", () => {
  it("gives every trade exactly two pages: a complete data table, then its screenshot page", async () => {
    const doc = await render([
      { trade: completeTrade({ id: 1, screenshotUrl: "https://files.test/a.png", screenshotName: "a.png", hasScreenshot: true }) },
      { trade: completeTrade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z", screenshotUrl: "https://files.test/b.png", screenshotName: "b.png", hasScreenshot: true }) },
      { trade: completeTrade({ id: 3, tradeDate: "2026-08-06T09:00:00.000Z", screenshotUrl: "https://files.test/c.png", screenshotName: "c.png", hasScreenshot: true }) },
    ]);
    expect([doc.pageOf("Trade 01 / 03"), doc.pageOf("Trade 02 / 03"), doc.pageOf("Trade 03 / 03")]).toEqual([1, 3, 5]);
    expect(doc.pagesWithImage()).toEqual([2, 4, 6]);
    // Two pages per trade, then the analysis pages — never three or four.
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(6);
    expect(doc.getNumberOfPages()).toBeLessThanOrEqual(6 + 3);
    expect(doc.violations).toEqual([]);
  });

  it("renders the complete trade card on one data page", async () => {
    const doc = await render([{ trade: completeTrade({ screenshotUrl: "https://files.test/a.png", screenshotName: "a.png", hasScreenshot: true }), runningBalance: 1070.9 }]);
    const written = doc.written();
    [
      "TRADE ID", "TRADE DATE", "SYMBOL", "MT5 TICKET", "SESSION", "DIRECTION", "RESULT", "TIMEFRAME",
      "LEVEL / CONFLUENCE", "SETUP QUALITY", "CONFIRMATION", "MARKET CONDITION", "BIAS ALIGNMENT",
      "EXECUTION TYPE", "SL PLACEMENT", "TP PLACEMENT", "HOLD QUALITY", "PATIENCE SCORE", "OPEN TIME (MT5)", "CLOSE TIME (MT5)", "TRADE DURATION",
      "PLANNED RISK", "PLANNED REWARD", "PLANNED R:R", "ACTUAL P&L", "ACTUAL R", "RUNNING BALANCE", "MFE", "MAE",
      "PLAN STATUS", "PLANNED / UNPLANNED", "PRE-TRADE CHECKLIST", "CHECKLIST COMPLETION", "PROCESS CLASSIFICATION", "RULE ADHERENCE", "PROCESS REVIEW",
      "MISTAKE / RULE-BREAK TAGS", "RULE-BREAK TAGS", "ANALYTICAL MISTAKES", "EXECUTION MISTAKES", "EMOTIONAL TRIGGERS", "ENVIRONMENTAL FACTORS",
      "BEFORE TRADE", "DURING TRADE", "AFTER TRADE", "JOURNAL NOTES",
    ].forEach(label => expect(written, `missing ${label}`).toContain(label));
    ["#17446150", "XAUUSD", "1 : 9.33", "+7.09R", "$10.00", "$93.30", "$70.90", "Calm", "Fear", "Regret", "Waited for the retest"].forEach(value => expect(written).toContain(value));
    // The checklist keeps every one of its ten items, compacted onto shared lines.
    expect(doc.flattened()).toContain("Setup exists");
    expect(doc.flattened()).toContain("Not revenge / FOMO driven");
    expect(doc.flattened()).toContain("✓ Setup exists · ✓ Setup matches today's plan");
    expect(doc.texts.filter(entry => entry.page === 1).length).toBeGreaterThan(30);
    expect(doc.violations).toEqual([]);
  });

  it("keeps a long journal note on the data page when it fits and continues it otherwise, never truncating", async () => {
    const longNote = Array.from({ length: 90 }, (_, index) => `Paragraph ${index + 1} of the journal entry with enough words to wrap across several lines in the generated document.`).join("\n");
    const doc = await render([{ trade: completeTrade({ notes: longNote }) }]);
    const written = doc.written();
    for (const index of [1, 2, 45, 89, 90]) expect(written).toContain(`Paragraph ${index} of`);
    // The overflow is explicit and attached to the same trade, not a second copy.
    expect(doc.flattened()).toContain("Trade 01 / 01 — complete trade data (continued)");
    expect(doc.violations).toEqual([]);
  });

  it("gives a short note trade a single data page", async () => {
    const doc = await render([{ trade: completeTrade({ notes: "Waited for the retest." }) }]);
    expect(doc.pageOf("Trade 01 / 01")).toBe(1);
    expect(doc.pageOf("Trade 01 / 01 — complete trade data (continued)")).toBeNull();
  });

  it("renders — for fields that exist but were never recorded", async () => {
    const doc = await render([{ trade: trade({ pnl: null, result: "", session: "", level: "", mt5Ticket: null, patienceScore: null, planChecklist: null, planStatus: null, notes: null, emotionBefore: null }) }]);
    const written = doc.written();
    ["SYMBOL", "MT5 TICKET", "PLANNED RISK", "PRE-TRADE CHECKLIST", "PLANNED / UNPLANNED", "JOURNAL NOTES"].forEach(label => expect(written).toContain(label));
    expect(written).toContain("—");
    expect(doc.violations).toEqual([]);
  });
});

describe("screenshot evidence pages", () => {
  it("embeds a screenshot with its real format, preserving its aspect ratio inside the page", async () => {
    const doc = await render([{ trade: completeTrade({ screenshotUrl: "https://files.test/chart.png", screenshotName: "chart.png", hasScreenshot: true }) }]);
    expect(doc.images).toHaveLength(1);
    const image = doc.images[0];
    expect(image.format).toBe("PNG");
    expect(image.page).toBe(2);
    expect(image.width / image.height).toBeCloseTo(1600 / 900, 2);
    expect(image.x).toBeGreaterThanOrEqual(PDF_PAGE.margin);
    expect(image.y + image.height).toBeLessThanOrEqual(PDF_PAGE.height - 12);
    expect(doc.flattened()).toContain("chart.png");
    expect(doc.flattened()).toContain("Embedded at");
    expect(doc.violations).toEqual([]);
  });

  it("scales a tall screenshot down proportionally instead of cropping it", async () => {
    const dataUrl = `data:image/png;base64,${PNG_1PX}`;
    const doc = new RecordingPdfDoc().withDimensions(dataUrl, 600, 2400);
    await render([{ trade: completeTrade({ screenshotUrl: "https://files.test/tall.png", screenshotName: "tall.png", hasScreenshot: true }) }], {
      doc,
      fetchImage: async () => ({ dataUrl, format: "PNG" }),
    });
    const image = doc.images[0];
    expect(image.width / image.height).toBeCloseTo(600 / 2400, 3);
    expect(image.height).toBeGreaterThan(100);
    expect(image.y + image.height).toBeLessThanOrEqual(PDF_PAGE.height - 12);
    expect(doc.violations).toEqual([]);
  });

  it("does not blow a small screenshot up to full page width", async () => {
    const dataUrl = `data:image/png;base64,${PNG_1PX}`;
    const doc = new RecordingPdfDoc().withDimensions(dataUrl, 240, 180);
    await render([{ trade: completeTrade({ screenshotUrl: "https://files.test/small.png", hasScreenshot: true }) }], { doc, fetchImage: async () => ({ dataUrl, format: "PNG" }) });
    expect(doc.images[0].width).toBeLessThan(PDF_PAGE.width / 2);
    expect(fitInside(100, 100, 240, 180).width).toBeCloseTo(100, 5);
  });

  it("renders a clean empty state when a trade has no screenshot", async () => {
    const doc = await render([{ trade: completeTrade({ screenshotUrl: null, screenshotName: null, hasScreenshot: false }) }]);
    expect(doc.images).toHaveLength(0);
    expect(doc.flattened()).toContain("NO SCREENSHOT AVAILABLE");
    expect(doc.flattened()).toContain("No screenshot was saved with this trade.");
    expect(doc.flattened()).toContain("MT5 #17446150");
    expect(doc.pageOf("Trade 01 / 01")).toBe(1);
    expect(doc.violations).toEqual([]);
  });

  it("keeps generating the report when a screenshot cannot be fetched", async () => {
    const doc = await render([{ trade: completeTrade({ screenshotUrl: "https://files.test/broken.png", screenshotName: "broken-entry.png", hasScreenshot: true, notes: "Journal marker UNIQUE-NOTE-42" }) }], {
      fetchImage: async () => { throw new Error("Screenshot request failed with 403"); },
    });
    expect(doc.images).toHaveLength(0);
    expect(doc.flattened()).toContain(SCREENSHOT_EMBED_FAILURE);
    expect(doc.flattened()).toContain("Screenshot unavailable at export time.");
    expect(doc.flattened()).toContain("broken-entry.png");
    expect(doc.flattened()).toContain("UNIQUE-NOTE-42");
    expect(doc.flattened()).toContain("Period analysis · Funded Gold");
    expect(doc.violations).toEqual([]);
  });

  it("fetches each screenshot once per export and remembers a failure", async () => {
    const fetchImage = vi.fn(async (url: string) => {
      if (url.includes("broken")) throw new Error("nope");
      return { dataUrl: `data:image/png;base64,${PNG_1PX}`, format: "PNG" };
    });
    const cache = createPdfImageCache(fetchImage);
    await Promise.all([cache("https://files.test/a.png"), cache("https://files.test/a.png")]);
    await expect(cache("https://files.test/broken.png")).rejects.toThrow();
    await expect(cache("https://files.test/broken.png")).rejects.toThrow();
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it("supports PNG, JPEG and WEBP screenshots", async () => {
    const formats: Record<string, string> = { "https://files.test/a.png": "PNG", "https://files.test/b.jpg": "JPEG", "https://files.test/c.webp": "WEBP" };
    const doc = await render([
      { trade: completeTrade({ id: 1, screenshotUrl: "https://files.test/a.png", hasScreenshot: true }) },
      { trade: completeTrade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z", screenshotUrl: "https://files.test/b.jpg", hasScreenshot: true }) },
      { trade: completeTrade({ id: 3, tradeDate: "2026-08-06T09:00:00.000Z", screenshotUrl: "https://files.test/c.webp", hasScreenshot: true }) },
    ], { fetchImage: async url => ({ dataUrl: `data:image/x;base64,${PNG_1PX}`, format: formats[url] }) });
    expect(doc.images.map(image => image.format)).toEqual(["PNG", "JPEG", "WEBP"]);
    expect(doc.pagesWithImage()).toEqual([2, 4, 6]);
    expect(doc.violations).toEqual([]);
  });
});

describe("report structure", () => {
  it("footers every page with the account, the period, and Page X / Y", async () => {
    const doc = await render([
      { trade: completeTrade({ id: 1, notes: "One." }) },
      { trade: completeTrade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z", notes: "Two." }) },
    ]);
    const total = doc.getNumberOfPages();
    expect(doc.footerPages()).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    expect(doc.written()).toContain("Page 1 / " + total);
    expect(doc.written()).toContain(`Gold Journal · Funded Gold · 2026-08-01 to 2026-08-31`);
    expect(doc.texts.filter(entry => entry.page === 1).some(entry => entry.align === "right")).toBe(true);
  });

  it("adds a compact period analysis whose numbers come from the exported trades", async () => {
    const doc = await render([
      { trade: completeTrade({ id: 1, pnl: "100.00", result: "WIN", risk: "10", session: "New York", direction: "BUY" }) },
      { trade: completeTrade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z", pnl: "-40.00", result: "LOSS", risk: "10", session: "London", direction: "SELL" }) },
      { trade: completeTrade({ id: 3, tradeDate: "2026-08-06T09:00:00.000Z", pnl: "0.00", result: "BREAK_EVEN", risk: "10", session: "New York", direction: "BUY" }) },
    ]);
    const written = doc.written();
    ["PERIOD", "PERFORMANCE OVERVIEW", "RISK & DRAWDOWN", "PERFORMANCE BY CONTEXT", "PLAN & DISCIPLINE", "PROCESS & BEHAVIOUR", "DAILY PERFORMANCE", "PERIOD OBSERVATIONS", "SESSION ANALYSIS", "DIRECTION ANALYSIS"].forEach(title => expect(written).toContain(title));
    expect(doc.flattened()).toContain("$60.00");
    expect(doc.flattened()).toContain("New York");
    // The analysis comes after the trade pages: 3 trades = 6 trade pages.
    expect(doc.pageOf("PERIOD")).toBe(7);
    expect(doc.violations).toEqual([]);
  });

  it("writes a single page when no trade matches the selected period", async () => {
    const doc = await render([]);
    expect(doc.getNumberOfPages()).toBe(1);
    expect(doc.images).toHaveLength(0);
    expect(doc.flattened()).toContain("No trades found for the selected period");
    expect(doc.flattened()).toContain("Page 1 / 1");
    expect(doc.violations).toEqual([]);
  });

  it("keeps the reference 9-trade report to two pages per trade plus the compact analysis", async () => {
    const sessions = ["New York", "London", "Asian", "Pre-London", "New York", "London", "New York", "Asian", "London"];
    const results = ["WIN", "LOSS", "BREAK_EVEN", "WIN", "LOSS", "WIN", "WIN", "LOSS", "WIN"];
    const pnls = ["70.90", "-48.20", "0.00", "134.10", "-52.30", "88.75", "210.40", "-40.00", "61.25"];
    const reference: TradeLogPdfTrade[] = Array.from({ length: 9 }, (_, index) => ({
      trade: completeTrade({
        id: 690 + index,
        tradeDate: `2026-09-${String(16 + Math.floor(index / 3)).padStart(2, "0")}T0${9 + (index % 3)}:15:00.000Z`,
        session: sessions[index], direction: index % 2 ? "SELL" : "BUY", result: results[index], pnl: pnls[index],
        notes: `Waited for the retest at the ${index % 2 ? "H4 supply" : "daily RBS"}, entered on displacement and managed into the target.`,
        screenshotUrl: "https://files.test/chart.png", screenshotName: `evidence-${index + 1}.png`, hasScreenshot: true,
      }),
    }));
    const doc = await render(reference);
    expect(doc.pageOf("Trade 09 / 09")).toBe(17);
    expect(doc.pagesWithImage()).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
    // 18 trade pages and a compact analysis: never the three-to-four pages per trade this report replaced.
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(19);
    expect(doc.getNumberOfPages()).toBeLessThanOrEqual(21);
    expect(doc.violations).toEqual([]);
  });

  it("exports only the trades it is handed, so another account can never appear", async () => {
    const doc = await render([{ trade: completeTrade({ id: 1, notes: "ACCOUNT-A-MARKER" }) }]);
    expect(doc.flattened()).toContain("ACCOUNT-A-MARKER");
    expect(doc.flattened()).not.toContain("OTHER-ACCOUNT");
  });
});

describe("image preparation", () => {
  it("detects the screenshot's real format from its bytes", () => {
    expect(detectImageFormat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBe("PNG");
    expect(detectImageFormat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("JPEG");
    expect(detectImageFormat(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("WEBP");
    expect(detectImageFormat(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("GIF");
    expect(detectImageFormat(Uint8Array.from([1, 2, 3]))).toBeNull();
  });

  it("prepares a fetched screenshot as a data URL in its detected format", async () => {
    const png = Uint8Array.from(atob(PNG_1PX), character => character.charCodeAt(0));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } })));
    const image = await fetchPdfImage("https://files.test/chart.png");
    expect(image.format).toBe("PNG");
    expect(image.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("produces a real multi-page jsPDF document with two pages per trade", async () => {
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });
    await renderTradeLogPdf(doc, {
      accountName: "Funded Gold",
      rangeLabel: "2026-08-01 to 2026-08-31",
      mode: "ALL_TIME",
      summary: summarizeBulkPdfTrades([completeTrade() as never]),
      trades: [
        { trade: completeTrade({ screenshotUrl: "https://files.test/chart.png", hasScreenshot: true }), runningBalance: 1250 },
        { trade: completeTrade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z" }) },
      ],
      fetchImage: async () => ({ dataUrl: `data:image/png;base64,${PNG_1PX}`, format: "PNG" }),
    });
    const bytes = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(4);
    expect(doc.getNumberOfPages()).toBeLessThanOrEqual(7);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(bytes.byteLength).toBeGreaterThan(5_000);
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(297, 0);
    expect(doc.internal.pageSize.getHeight()).toBeCloseTo(210, 0);
  });
});
