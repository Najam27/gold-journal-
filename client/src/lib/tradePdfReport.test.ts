import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeBulkPdfTrades } from "./bulkPdf";
import { PDF_COLORS, PDF_PAGE, SCREENSHOT_EMBED_FAILURE, createPdfImageCache, detectImageFormat, fetchPdfImage, fitInside, renderTradeLogPdf, type PdfDoc, type PdfImage, type PdfTextOptions, type TradeLogPdfTrade } from "./tradePdfReport";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type TextCall = { text: string; x: number; y: number; size: number; page: number; align: string };
type ImageCall = { format: string; x: number; y: number; width: number; height: number; page: number; dataUrl: string };

/**
 * A jsPDF-shaped recorder for the A4 landscape report. It validates page bounds
 * the way the real writer must (text inside the page, images inside the page) so a
 * layout regression fails the test instead of silently clipping the document.
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
  setDrawColor() { return this; }
  setLineWidth() { return this; }
  setFontSize(size: number) { this.fontSize = size; return this; }
  setFont() { return this; }
  rect() { return this; }
  roundedRect() { return this; }
  line() { return this; }
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
  pagesWithText(text: string) { return Array.from(new Set(this.texts.filter(entry => entry.text === text).map(entry => entry.page))); }
  pagesWithImage() { return Array.from(new Set(this.images.map(image => image.page))).sort((a, b) => a - b); }
  footerPages() { return Array.from(new Set(this.texts.filter(entry => entry.text.startsWith("Page ")).map(entry => entry.page))).sort((a, b) => a - b); }
  /** Content bottom of a page, ignoring the footer line. */
  contentMaxY(page: number) {
    return Math.max(...this.texts.filter(entry => entry.page === page && entry.y < PDF_PAGE.footerBaseline - 2).map(entry => entry.y), 0);
  }
  smallestFont() { return Math.min(...this.texts.map(entry => entry.size)); }
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

describe("trade page layout", () => {
  it("gives an ordinary trade exactly one data page followed by its screenshot page", async () => {
    const doc = await render([
      { trade: completeTrade({ id: 1, screenshotUrl: "https://files.test/a.png", screenshotName: "a.png", hasScreenshot: true }) },
      { trade: completeTrade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z", screenshotUrl: "https://files.test/b.png", screenshotName: "b.png", hasScreenshot: true }) },
      { trade: completeTrade({ id: 3, tradeDate: "2026-08-06T09:00:00.000Z", screenshotUrl: "https://files.test/c.png", screenshotName: "c.png", hasScreenshot: true }) },
    ]);
    expect([doc.pageOf("TRADE 01 / 03"), doc.pageOf("TRADE 02 / 03"), doc.pageOf("TRADE 03 / 03")]).toEqual([1, 3, 5]);
    expect(doc.pagesWithImage()).toEqual([2, 4, 6]);
    expect(doc.violations).toEqual([]);
  });

  it("shows the identity once, in a single header line, and keeps it out of the field table header", async () => {
    const doc = await render([{ trade: completeTrade({ screenshotUrl: "https://files.test/a.png", hasScreenshot: true }) }]);
    expect(doc.pageOf("TRADE 01 / 01")).toBe(1);
    expect(doc.written()).toContain("04/08/2026 · XAUUSD · LONDON · BUY · WIN");
    // The old dark-export headers repeated date/symbol/session/direction/result in
    // the eyebrow, the title, a band, and the field table; each now appears once.
    const occurrences = doc.texts.filter(entry => entry.text === "04/08/2026 · XAUUSD · LONDON · BUY · WIN");
    expect(occurrences).toHaveLength(1);
    expect(doc.written()).not.toContain("GOLD JOURNAL · TRADE CARD");
  });

  it("leads with a KPI strip of the trade's headline figures", async () => {
    const doc = await render([{ trade: completeTrade({ hasScreenshot: false }) }]);
    ["ACTUAL P&L", "ACTUAL R", "PLANNED R:R", "RULE ADHERENCE", "CHECKLIST COMPLETION", "PATIENCE SCORE"].forEach(label => expect(doc.written()).toContain(label));
    expect(doc.written()).toContain("+7.09R");
    expect(doc.written()).toContain("1 : 9.33");
    expect(doc.written()).toContain("9 / 10 checks confirmed");
    expect(doc.written()).toContain("4/5");
  });

  it("renders the complete trade card in the report's section order", async () => {
    const doc = await render([{ trade: completeTrade({ screenshotUrl: "https://files.test/a.png", hasScreenshot: true }), runningBalance: 1070.9 }]);
    const written = doc.written();
    ["1 · TRADE OVERVIEW", "2 · STRATEGY & EXECUTION", "3 · RISK & PERFORMANCE", "4 · PLAN & DISCIPLINE", "PRE-TRADE CHECKLIST", "6 · PROCESS & MISTAKES", "7 · PSYCHOLOGY", "JOURNAL NOTE"].forEach(label => expect(written, `missing ${label}`).toContain(label));
    ["TRADE ID", "MT5 TICKET", "TRADE DATE", "SYMBOL", "SESSION", "DIRECTION", "RESULT", "TIMEFRAME", "OPEN TIME (MT5)", "CLOSE TIME (MT5)", "TRADE DURATION",
      "LEVEL / CONFLUENCE", "SETUP QUALITY", "CONFIRMATION", "MARKET CONDITION", "BIAS ALIGNMENT", "EXECUTION TYPE", "SL PLACEMENT", "TP PLACEMENT", "HOLD QUALITY", "PATIENCE SCORE",
      "PLANNED RISK", "PLANNED REWARD", "PLANNED R:R", "ACTUAL P&L", "ACTUAL R", "RUNNING BALANCE", "MFE", "MAE",
      "PLAN STATUS", "PLANNED / UNPLANNED", "CHECKLIST COMPLETION", "RULE ADHERENCE", "PROCESS CLASSIFICATION", "PROCESS REVIEW",
      "MISTAKE TAGS", "RULE-BREAK TAGS", "ANALYTICAL MISTAKES", "EXECUTION MISTAKES", "EMOTIONAL TRIGGERS", "ENVIRONMENTAL FACTORS",
      "BEFORE TRADE", "DURING TRADE", "AFTER TRADE"].forEach(label => expect(written, `missing ${label}`).toContain(label));
    ["#17446150", "XAUUSD", "1 : 9.33", "+7.09R", "$10.00", "$93.30", "$70.90", "Calm", "Fear", "Regret", "Waited for the retest"].forEach(value => expect(written).toContain(value));
    expect(doc.violations).toEqual([]);
  });

  it("keeps every checklist item, split into two columns of confirmed and unconfirmed rows", async () => {
    const doc = await render([{ trade: completeTrade({ hasScreenshot: false }) }]);
    expect(doc.flattened()).toContain("Setup exists");
    expect(doc.flattened()).toContain("Not revenge / FOMO driven");
    expect(doc.flattened()).toContain("Entry condition confirmed");
    const marks = doc.texts.filter(entry => entry.text === "✓" || entry.text === "✗");
    expect(marks).toHaveLength(10);
    expect(marks.filter(entry => entry.text === "✗")).toHaveLength(1);
    // Two columns inside the block: the sixth item sits a column to the right.
    const lastItem = doc.texts.find(entry => entry.text === "Not revenge / FOMO driven");
    const firstItem = doc.texts.find(entry => entry.text === "Setup exists");
    expect(lastItem && firstItem && lastItem.x > firstItem.x + 40).toBe(true);
  });

  it("gives the process classification its own panel so P&L never implies process", async () => {
    const goodWin = await render([{ trade: completeTrade({ mistake: null, planStatus: "PLANNED" }) }]);
    expect(goodWin.flattened()).toContain("GOOD WIN");
    const badWin = await render([{ trade: completeTrade({ mistake: "Revenge|Oversize" }) }]);
    expect(badWin.flattened()).toContain("BAD WIN");
    expect(badWin.flattened()).toContain("Profitable result, poor process.");
  });

  it("keeps a long journal note on the data page when it fits and continues it otherwise, never truncating", async () => {
    const longNote = Array.from({ length: 90 }, (_, index) => `Paragraph ${index + 1} of the journal entry with enough words to wrap across several lines in the generated document.`).join("\n");
    const doc = await render([{ trade: completeTrade({ notes: longNote, hasScreenshot: false }) }]);
    const written = doc.written();
    for (const index of [1, 2, 45, 89, 90]) expect(written).toContain(`Paragraph ${index} of`);
    // The overflow is explicit, labelled, and attached to the same trade.
    expect(doc.flattened()).toContain("TRADE 01 / 01 — TRADE DATA (CONTINUED)");
    expect(doc.flattened()).toContain("8 · JOURNAL NOTE (CONTINUED)");
    expect(doc.violations).toEqual([]);
  });

  it("gives a short note trade a single data page", async () => {
    const doc = await render([{ trade: completeTrade({ notes: "Waited for the retest.", hasScreenshot: false }) }]);
    expect(doc.pageOf("TRADE 01 / 01")).toBe(1);
    expect(doc.pageOf("TRADE 01 / 01 — TRADE DATA (CONTINUED)")).toBeNull();
  });

  it("renders — for fields that exist but were never recorded", async () => {
    const doc = await render([{ trade: trade({ pnl: null, result: "", session: "", level: "", mt5Ticket: null, patienceScore: null, planChecklist: null, planStatus: null, notes: null, emotionBefore: null, hasScreenshot: false }) }]);
    const written = doc.written();
    ["SYMBOL", "MT5 TICKET", "PLANNED RISK", "CHECKLIST COMPLETION", "PLANNED / UNPLANNED", "JOURNAL NOTE"].forEach(label => expect(written).toContain(label));
    expect(written).toContain("—");
    expect(doc.violations).toEqual([]);
  });

  it("never uses an unreadably small font, even when the layout is compressed", async () => {
    const heavy = completeTrade({
      hasScreenshot: false,
      notes: Array.from({ length: 40 }, (_, index) => `Note ${index + 1}: a long journal paragraph that pushes the page toward its compact typography tier.`).join("\n"),
    });
    const doc = await render([{ trade: heavy }]);
    expect(doc.smallestFont()).toBeGreaterThanOrEqual(6.4);
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
    // The evidence bar carries the identifying metadata once.
    ["TRADE", "MT5 TICKET", "SYMBOL", "SCREENSHOT", "IMAGE"].forEach(label => expect(doc.written()).toContain(label));
    expect(doc.flattened()).toContain("chart.png");
    expect(doc.flattened()).toContain("PNG · 1600 × 900 px");
    expect(doc.violations).toEqual([]);
  });

  it("scales a tall screenshot down proportionally instead of cropping it", async () => {
    const dataUrl = `data:image/png;base64,${PNG_1PX}`;
    const doc = new RecordingPdfDoc().withDimensions(dataUrl, 600, 2400);
    await render([{ trade: completeTrade({ screenshotUrl: "https://files.test/tall.png", screenshotName: "tall.png", hasScreenshot: true }) }], { doc, fetchImage: async () => ({ dataUrl, format: "PNG" }) });
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

  it("renders a clean empty state, still on its own page, when a trade has no screenshot", async () => {
    const doc = await render([{ trade: completeTrade({ screenshotUrl: null, screenshotName: null, hasScreenshot: false }) }]);
    expect(doc.images).toHaveLength(0);
    expect(doc.flattened()).toContain("NO SCREENSHOT AVAILABLE");
    expect(doc.flattened()).toContain("MT5 #17446150");
    expect(doc.pageOf("TRADE 01 / 01")).toBe(1);
    expect(doc.violations).toEqual([]);
  });

  it("keeps generating the report when a screenshot cannot be fetched", async () => {
    const doc = await render([{ trade: completeTrade({ screenshotUrl: "https://files.test/broken.png", screenshotName: "broken-entry.png", hasScreenshot: true, notes: "Journal marker UNIQUE-NOTE-42" }) }], {
      fetchImage: async () => { throw new Error("Screenshot request failed with 403"); },
    });
    expect(doc.images).toHaveLength(0);
    expect(doc.flattened()).toContain("SCREENSHOT COULD NOT BE LOADED");
    expect(doc.flattened()).toContain(SCREENSHOT_EMBED_FAILURE);
    expect(doc.flattened()).toContain("broken-entry.png");
    expect(doc.flattened()).toContain("UNIQUE-NOTE-42");
    // The analysis still follows the trade pages.
    expect(doc.flattened()).toContain("Performance overview");
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
      { trade: completeTrade({ id: 1, notes: "One.", hasScreenshot: false }) },
      { trade: completeTrade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z", notes: "Two.", hasScreenshot: false }) },
    ]);
    const total = doc.getNumberOfPages();
    expect(doc.footerPages()).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    expect(doc.written()).toContain("Page 1 / " + total);
    expect(doc.written()).toContain("Gold Journal · Funded Gold · 2026-08-01 to 2026-08-31");
    expect(doc.texts.filter(entry => entry.page === 1).some(entry => entry.align === "right")).toBe(true);
  });

  it("adds the four analysis pages, each answering one question, after the trade pages", async () => {
    const doc = await render([
      { trade: completeTrade({ id: 1, pnl: "100.00", result: "WIN", session: "New York", direction: "BUY", hasScreenshot: false }) },
      { trade: completeTrade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z", pnl: "-40.00", result: "LOSS", session: "London", direction: "SELL", hasScreenshot: false }) },
      { trade: completeTrade({ id: 3, tradeDate: "2026-08-06T09:00:00.000Z", pnl: "0.00", result: "BREAK_EVEN", session: "New York", direction: "BUY", hasScreenshot: false }) },
    ]);
    expect([doc.pageOf("Performance overview"), doc.pageOf("Process & behaviour"), doc.pageOf("Psychology & mistakes"), doc.pageOf("Review summary")]).toEqual([7, 8, 9, 10]);
    const written = doc.written();
    ["NET P&L", "WIN RATE", "PROFIT FACTOR", "EXPECTANCY", "TOTAL R", "MAX DRAWDOWN"].forEach(label => expect(written).toContain(label));
    ["SESSION PERFORMANCE", "DIRECTION PERFORMANCE", "TIMEFRAME PERFORMANCE", "SETUP PERFORMANCE", "DAILY PERFORMANCE"].forEach(label => expect(written).toContain(label));
    ["PLAN & DISCIPLINE", "RISK & DRAWDOWN", "PROCESS CLASSIFICATION", "EXECUTION TYPE", "HOLD QUALITY", "PATIENCE DISTRIBUTION"].forEach(label => expect(written).toContain(label));
    ["MISTAKE / RULE-BREAK FREQUENCY", "PROCESS, EMOTIONAL, AND ENVIRONMENTAL TAGS", "RECORDED EMOTIONS", "REPEATED BEHAVIOURAL PATTERNS"].forEach(label => expect(written).toContain(label));
    ["PERFORMANCE OBSERVATIONS", "RISK OBSERVATIONS", "EXECUTION OBSERVATIONS", "PROCESS OBSERVATIONS", "PSYCHOLOGY OBSERVATIONS", "WHAT TO REPEAT", "WHAT TO REVIEW", "WHAT TO WATCH NEXT SESSION"].forEach(label => expect(written).toContain(label));
    expect(doc.flattened()).toContain("$60.00");
    expect(doc.violations).toEqual([]);
  });

  it("lays the review page out in two balanced columns", async () => {
    const doc = await render([{ trade: completeTrade({ hasScreenshot: false }) }]);
    const page = doc.pageOf("Review summary");
    expect(page).toBeTruthy();
    const bullets = doc.texts.filter(entry => entry.page === page && entry.text === "•");
    const left = bullets.filter(entry => entry.x < PDF_PAGE.width / 2).length;
    const right = bullets.filter(entry => entry.x >= PDF_PAGE.width / 2).length;
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(0);
  });

  it("writes a single page when no trade matches the selected period", async () => {
    const doc = await render([]);
    expect(doc.getNumberOfPages()).toBe(1);
    expect(doc.images).toHaveLength(0);
    expect(doc.flattened()).toContain("No trades found for the selected period");
    expect(doc.flattened()).toContain("Page 1 / 1");
    expect(doc.violations).toEqual([]);
  });

  it("exports only the trades it is handed, so another account can never appear", async () => {
    const doc = await render([{ trade: completeTrade({ id: 1, notes: "ACCOUNT-A-MARKER", hasScreenshot: false }) }]);
    expect(doc.flattened()).toContain("ACCOUNT-A-MARKER");
    expect(doc.flattened()).not.toContain("OTHER-ACCOUNT");
  });

  it("uses its own light print palette, independent of the application theme", () => {
    // White page with dark ink: a dark theme can never leak into the document.
    expect(PDF_COLORS.page).toEqual([255, 255, 255]);
    expect(PDF_COLORS.ink[0]).toBeLessThan(60);
    expect(PDF_COLORS.positive[1]).toBeGreaterThan(PDF_COLORS.positive[0]);
    expect(PDF_COLORS.negative[0]).toBeGreaterThan(PDF_COLORS.negative[1]);
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
      }), runningBalance: null,
    }));
    const doc = await render(reference);
    expect(doc.pageOf("TRADE 09 / 09")).toBe(17);
    expect(doc.pagesWithImage()).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
    // 18 trade pages and four analysis pages, never the three-to-four pages per
    // trade this report replaced.
    expect(doc.getNumberOfPages()).toBe(22);
    expect(doc.violations).toEqual([]);
    // No page is left blank, and no page runs past the content area.
    for (let page = 1; page <= doc.getNumberOfPages(); page += 1) {
      expect(doc.texts.some(entry => entry.page === page), `page ${page} is empty`).toBe(true);
      expect(doc.contentMaxY(page)).toBeLessThanOrEqual(PDF_PAGE.height - 12);
    }
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
        { trade: completeTrade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z", hasScreenshot: false }) },
      ],
      fetchImage: async () => ({ dataUrl: `data:image/png;base64,${PNG_1PX}`, format: "PNG" }),
    });
    const bytes = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
    // Two trades = two data pages, two evidence pages, and four analysis pages.
    expect(doc.getNumberOfPages()).toBe(8);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(bytes.byteLength).toBeGreaterThan(5_000);
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(297, 0);
    expect(doc.internal.pageSize.getHeight()).toBeCloseTo(210, 0);
  });
});
