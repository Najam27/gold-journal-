import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeBulkPdfTrades } from "./bulkPdf";
import {
  PDF_COLORS,
  PDF_MIN_FONT,
  PDF_PAGE,
  PDF_SECTION_COLORS,
  SCREENSHOT_EMBED_FAILURE,
  SECTION_GAP,
  ascent,
  createPdfImageCache,
  descent,
  detectImageFormat,
  fetchPdfImage,
  findLayoutOverlaps,
  fitInside,
  hexToRgb,
  renderTradeLogPdf,
  type PdfDoc,
  type PdfImage,
  type PdfLayoutBlock,
  type PdfTextOptions,
  type TradeLogPdfTrade,
} from "./tradePdfReport";
import { PRESENTATION_MISSING, TRADE_PRESENTATION_LABELS, TRADE_SECTION_THEME, buildTradePresentation, type TradePresentationSectionId } from "./tradePresentation";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type TextCall = { text: string; x: number; y: number; size: number; page: number; align: string };
type ImageCall = { format: string; x: number; y: number; width: number; height: number; page: number; dataUrl: string };

/**
 * A jsPDF-shaped recorder for the A4 landscape report.
 *
 * It validates the document the way a printer would: text and images must stay
 * inside the page, no two pieces of text may occupy the same spot on a page, and
 * nothing may be drawn below the content area. A layout regression therefore fails
 * the test instead of silently clipping or overlapping the document.
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
      if (align === "left" && x + this.width(line, this.fontSize) > PDF_PAGE.width + 1) this.violations.push(`text overflows the page: ${line}`);
      if (this.fontSize < PDF_MIN_FONT && !line.startsWith("Page ") && !line.startsWith("Gold Journal ·")) this.violations.push(`unreadable text (${this.fontSize}pt): ${line}`);
    }
    return this;
  }
  /**
   * jsPDF measures real Helvetica widths: ~0.176 mm per point per glyph for mixed
   * lower-case text and ~0.23 for capitals. This recorder deliberately uses the
   * wider figure so a test never claims a layout fits when only a narrower
   * measurement would allow it.
   */
  splitTextToSize(text: string, maxWidth: number) {
    const perLine = Math.max(6, Math.floor(maxWidth / (this.fontSize * 0.22)));
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
  contentMaxY(page: number) {
    return Math.max(...this.texts.filter(entry => entry.page === page && entry.y < PDF_PAGE.footerBaseline - 2).map(entry => entry.y), 0);
  }
  smallestFont() { return Math.min(...this.texts.map(entry => entry.size)); }

  private width(text: string, size: number) { return text.length * size * 0.22; }
  private interval(entry: TextCall): [number, number] {
    const width = this.width(entry.text, entry.size);
    if (entry.align === "right") return [entry.x - width, entry.x];
    if (entry.align === "center") return [entry.x - width / 2, entry.x + width / 2];
    return [entry.x, entry.x + width];
  }
  /** Any two text runs on a page that occupy the same place. */
  overlaps(): string[] {
    const problems: string[] = [];
    const byPage = new Map<number, TextCall[]>();
    for (const entry of this.texts) {
      const list = byPage.get(entry.page) ?? [];
      list.push(entry);
      byPage.set(entry.page, list);
    }
    for (const [page, entries] of byPage) {
      for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
          const a = entries[i];
          const b = entries[j];
          if (Math.abs(a.y - b.y) > 1.2) continue;
          const [aStart, aEnd] = this.interval(a);
          const [bStart, bEnd] = this.interval(b);
          if (Math.min(aEnd, bEnd) - Math.max(aStart, bStart) > 0.8) problems.push(`"${a.text}" overlaps "${b.text}" on page ${page}`);
        }
      }
    }
    return problems;
  }
}

const trade = (overrides: Record<string, unknown> = {}) => ({ id: 1, accountId: 3, tradeDate: "2026-08-04T09:00:00.000Z", pnl: "10.00", result: "WIN", session: "London", direction: "BUY", ...overrides });

/** A trade carrying every field the canonical presentation model can show. */
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

/** A value is present if it is drawn verbatim, or as the first line of a wrapped run. */
function appearsIn(doc: RecordingPdfDoc, value: string) {
  const firstLine = value.split("\n")[0].trim();
  if (!firstLine) return true;
  if (doc.written().includes(firstLine)) return true;
  const head = firstLine.split(" ").slice(0, 5).join(" ");
  return doc.texts.some(entry => entry.text.startsWith(head));
}

afterEach(() => vi.unstubAllGlobals());

describe("trade data page", () => {
  it("gives an ordinary trade exactly one data page followed by its screenshot page", async () => {
    const doc = await render([
      { trade: completeTrade({ id: 1, screenshotUrl: "https://files.test/a.png", screenshotName: "a.png", hasScreenshot: true }) },
      { trade: completeTrade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z", screenshotUrl: "https://files.test/b.png", screenshotName: "b.png", hasScreenshot: true }) },
      { trade: completeTrade({ id: 3, tradeDate: "2026-08-06T09:00:00.000Z", screenshotUrl: "https://files.test/c.png", screenshotName: "c.png", hasScreenshot: true }) },
    ]);
    expect([doc.pageOf("TRADE 01 / 03"), doc.pageOf("TRADE 02 / 03"), doc.pageOf("TRADE 03 / 03")]).toEqual([1, 3, 5]);
    expect(doc.pagesWithImage()).toEqual([2, 4, 6]);
    expect(doc.violations).toEqual([]);
    expect(doc.overlaps()).toEqual([]);
  });

  it("states the trade's identity once, in the page header", async () => {
    const doc = await render([{ trade: completeTrade({ hasScreenshot: false }) }]);
    expect(doc.pageOf("TRADE 01 / 01")).toBe(1);
    expect(doc.texts.filter(entry => entry.text === "04/08/2026 · XAUUSD · LONDON · BUY · WIN")).toHaveLength(1);
    // The identity fields are not repeated as table rows on the trade page.
    const pageOne = doc.texts.filter(entry => entry.page === 1).map(entry => entry.text);
    ["TRADE DATE", "SYMBOL", "SESSION", "DIRECTION", "RESULT"].forEach(label => expect(pageOne).not.toContain(label));
  });

  it("leads with the trade's key figures as KPI tiles", async () => {
    const doc = await render([{ trade: completeTrade({ hasScreenshot: false }) }]);
    ["ACTUAL P&L", "ACTUAL R", "PLANNED R:R", "RULE ADHERENCE", "CHECKLIST COMPLETION", "PATIENCE SCORE"].forEach(label => expect(doc.written()).toContain(label));
    expect(doc.written()).toContain("+7.09R");
    expect(doc.written()).toContain("1 : 9.33");
    expect(doc.written()).toContain("9 / 10 checks confirmed");
    expect(doc.written()).toContain("4/5");
  });

  it("lays the complete trade out as colour-coded section tables", async () => {
    const doc = await render([{ trade: completeTrade({ hasScreenshot: false }), runningBalance: 1070.9 }]);
    const written = doc.written();
    ["TRADE OVERVIEW", "STRATEGY", "EXECUTION", "RISK & PERFORMANCE", "PLAN & DISCIPLINE", "PROCESS", "PRE-TRADE CHECKLIST", "MISTAKES & BEHAVIOUR", "PSYCHOLOGY", "JOURNAL NOTES"]
      .forEach(label => expect(written, `missing band ${label}`).toContain(label));
    // The colour-coded bands read the shared section palette, so the report cannot
    // drift from (or flatten) the colours the Trade Card uses.
    (Object.keys(TRADE_SECTION_THEME) as TradePresentationSectionId[]).forEach(id => {
      expect(PDF_SECTION_COLORS[id], `section ${id} accent`).toEqual(hexToRgb(TRADE_SECTION_THEME[id].accent));
    });
    expect(new Set(Object.values(PDF_SECTION_COLORS).map(color => color.join(","))).size).toBe(9);
  });

  it("prints every canonical field label and value, with nothing dropped", async () => {
    const doc = await render([{ trade: completeTrade({ hasScreenshot: false }), runningBalance: 1070.9 }]);
    const model = buildTradePresentation(completeTrade(), { runningBalance: 1070.9 });
    const labels = TRADE_PRESENTATION_LABELS.filter(label => !["Trade date", "Symbol", "Session", "Direction", "Result"].includes(label));
    labels.forEach(label => expect(doc.written(), `missing label ${label}`).toContain(label.toUpperCase()));
    for (const section of model.sections) {
      for (const field of section.fields) {
        if (field.inHeader || field.key === "checklistCompletion") continue;
        expect(appearsIn(doc, field.value), `missing value for ${field.label}: ${field.value}`).toBe(true);
      }
    }
    ["XAUUSD", "1 : 9.33", "+7.09R", "$10.00", "$93.30", "$70.90", "Calm", "Fear", "Regret", "Waited for the retest", "Impatience|Closed early|Entered without confirmation", "$1,070.90"]
      .forEach(value => expect(doc.written()).toContain(value));
    expect(doc.violations).toEqual([]);
    expect(doc.overlaps()).toEqual([]);
  });

  it("never prints technical or internal metadata", async () => {
    const doc = await render([{ trade: completeTrade({ screenshotUrl: "https://signed.example/private/evidence.png", screenshotName: "new-york-retest.png", screenshotKey: "gold-journal/owner/accounts/11/trades/696/private.png", hasScreenshot: true }) }]);
    const written = doc.flattened();
    ["MT5", "mt5", "17446150", "new-york-retest", ".png", "signed.example", "gold-journal", "userId", "accountId", "PNG", "JPEG", "WEBP", "px", "image dimensions"]
      .forEach(secret => expect(written, `leaked ${secret}`).not.toContain(secret));
  });

  it("keeps every checklist item, split into confirmed and unconfirmed columns", async () => {
    const doc = await render([{ trade: completeTrade({ hasScreenshot: false }) }]);
    expect(doc.flattened()).toContain("Setup exists");
    expect(doc.flattened()).toContain("Not revenge / FOMO driven");
    expect(doc.flattened()).toContain("Entry condition confirmed");
    const marks = doc.texts.filter(entry => entry.text === "✓" || entry.text === "✗");
    expect(marks).toHaveLength(10);
    expect(marks.filter(entry => entry.text === "✓")).toHaveLength(9);
    // Two columns inside the block: the sixth item sits a column to the right.
    const lastItem = doc.texts.find(entry => entry.text === "Not revenge / FOMO driven");
    const firstItem = doc.texts.find(entry => entry.text === "Setup exists");
    expect(lastItem && firstItem && lastItem.x > firstItem.x + 40).toBe(true);
  });

  it("describes the process in its own panel so P&L never implies process", async () => {
    const badWin = await render([{ trade: completeTrade({ hasScreenshot: false }) }]);
    expect(badWin.flattened()).toContain("BAD WIN");
    expect(badWin.flattened()).toContain("Profitable result, poor process.");
    const goodWin = await render([{ trade: completeTrade({ mistake: null, planStatus: "PLANNED" }) }]);
    expect(goodWin.flattened()).toContain("GOOD WIN");
  });

  it("keeps a long journal note whole, continuing it on a labelled page instead of truncating", async () => {
    // Each segment carries an unbreakable marker so the assertion is exact even when
    // a line wrap or a page break falls between two words of the surrounding prose.
    const marker = (index: number) => `Segment-${String(index).padStart(4, "0")}`;
    const longNote = Array.from({ length: 90 }, (_, index) => `${marker(index + 1)} records what happened during this part of the session in enough words to wrap across several lines of the generated report.`).join("\n");
    const doc = await render([{ trade: completeTrade({ notes: longNote, hasScreenshot: false }) }]);
    const written = doc.written();
    // Every recorded segment must survive the export — not just the first few.
    for (let index = 1; index <= 90; index += 1) expect(written, `journal ${marker(index)} must reach the document`).toContain(marker(index));
    expect(doc.flattened()).toContain("TRADE 01 / 01 — TRADE DATA (CONTINUED)");
    expect(doc.flattened()).toContain("JOURNAL NOTES (CONTINUED)");
    expect(doc.violations).toEqual([]);
    expect(doc.overlaps()).toEqual([]);
  });

  it("keeps an ordinary trade on a single data page", async () => {
    const doc = await render([{ trade: completeTrade({ notes: "Waited for the retest.", hasScreenshot: false }) }]);
    expect(doc.pageOf("TRADE 01 / 01")).toBe(1);
    expect(doc.pageOf("TRADE 01 / 01 — TRADE DATA (CONTINUED)")).toBeNull();
  });

  it("renders — for fields that exist but were never recorded", async () => {
    const doc = await render([{ trade: trade({ pnl: null, result: "", session: "", symbol: "", level: "", patienceScore: null, planChecklist: null, planStatus: null, notes: null, emotionBefore: null, hasScreenshot: false }) }]);
    ["PLANNED RISK", "CHECKLIST COMPLETION", "PLANNED / UNPLANNED", "JOURNAL NOTES"].forEach(label => expect(doc.written()).toContain(label));
    expect(doc.written()).toContain(PRESENTATION_MISSING);
    expect(doc.violations).toEqual([]);
  });

  it("never drops the read type below the printable floor when the page is squeezed", async () => {
    const heavy = completeTrade({
      hasScreenshot: false,
      notes: Array.from({ length: 40 }, (_, index) => `Note ${index + 1}: a long journal paragraph that pushes the page toward its compact typography tier.`).join("\n"),
    });
    const doc = await render([{ trade: heavy }]);
    expect(doc.smallestFont()).toBeGreaterThanOrEqual(PDF_MIN_FONT);
    expect(doc.violations).toEqual([]);
  });
});

describe("screenshot evidence pages", () => {
  it("embeds the screenshot with its real format and preserves its aspect ratio", async () => {
    const doc = await render([{ trade: completeTrade({ screenshotUrl: "https://files.test/chart.png", hasScreenshot: true }) }]);
    expect(doc.images).toHaveLength(1);
    const image = doc.images[0];
    expect(image.format).toBe("PNG");
    expect(image.page).toBe(2);
    expect(image.width / image.height).toBeCloseTo(1600 / 900, 2);
    expect(image.x).toBeGreaterThanOrEqual(PDF_PAGE.margin);
    expect(image.y + image.height).toBeLessThanOrEqual(PDF_PAGE.height - 12);
    expect(doc.pageOf("Screenshot evidence")).toBe(2);
    expect(doc.violations).toEqual([]);
  });

  it("scales a tall screenshot down proportionally instead of cropping it", async () => {
    const dataUrl = `data:image/png;base64,${PNG_1PX}`;
    const doc = new RecordingPdfDoc().withDimensions(dataUrl, 600, 2400);
    await render([{ trade: completeTrade({ screenshotUrl: "https://files.test/tall.png", hasScreenshot: true }) }], { doc, fetchImage: async () => ({ dataUrl, format: "PNG" }) });
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
    expect(doc.flattened()).toContain("NO SCREENSHOT ATTACHED");
    expect(doc.pageOf("TRADE 01 / 01")).toBe(1);
    expect(doc.flattened()).toContain("04/08/2026");
    expect(doc.violations).toEqual([]);
  });

  it("keeps generating the report when a screenshot cannot be fetched, without debug details", async () => {
    const doc = await render([{ trade: completeTrade({ screenshotUrl: "https://files.test/broken.png", screenshotName: "broken-entry.png", hasScreenshot: true, notes: "Journal marker UNIQUE-NOTE-42" }) }], {
      fetchImage: async () => { throw new Error("Screenshot request failed with 403"); },
    });
    expect(doc.images).toHaveLength(0);
    expect(doc.flattened()).toContain("SCREENSHOT COULD NOT BE LOADED");
    expect(doc.flattened()).toContain(SCREENSHOT_EMBED_FAILURE);
    expect(doc.flattened()).toContain("UNIQUE-NOTE-42");
    expect(doc.flattened()).not.toContain("403");
    expect(doc.flattened()).not.toContain("broken-entry");
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

  it("adds the analysis pages, each answering one question, after the trade pages", async () => {
    const doc = await render([
      { trade: completeTrade({ id: 1, pnl: "100.00", result: "WIN", session: "New York", direction: "BUY", hasScreenshot: false }) },
      { trade: completeTrade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z", pnl: "-40.00", result: "LOSS", session: "London", direction: "SELL", hasScreenshot: false }) },
      { trade: completeTrade({ id: 3, tradeDate: "2026-08-06T09:00:00.000Z", pnl: "0.00", result: "BREAK_EVEN", session: "New York", direction: "BUY", hasScreenshot: false }) },
    ]);
    expect([doc.pageOf("Performance overview"), doc.pageOf("Process & behaviour"), doc.pageOf("Psychology & mistakes"), doc.pageOf("Review summary")]).toEqual([7, 8, 9, 10]);
    const written = doc.written();
    ["NET P&L", "WIN RATE", "PROFIT FACTOR", "EXPECTANCY", "TOTAL R", "MAX DRAWDOWN"].forEach(label => expect(written).toContain(label));
    ["SESSION PERFORMANCE", "DIRECTION PERFORMANCE", "TIMEFRAME PERFORMANCE", "SETUP PERFORMANCE", "DAILY PERFORMANCE"].forEach(label => expect(written).toContain(label));
    ["PLAN & DISCIPLINE", "RISK & PROCESS CONTROL", "PROCESS CLASSIFICATION", "EXECUTION TYPE", "HOLD QUALITY", "PATIENCE DISTRIBUTION"].forEach(label => expect(written).toContain(label));
    ["MISTAKE / RULE-BREAK FREQUENCY", "PROCESS, EMOTIONAL, AND ENVIRONMENTAL TAGS", "RECORDED EMOTIONS", "DATA QUALITY & LIMITATIONS"].forEach(label => expect(written).toContain(label));
    ["PERFORMANCE SUMMARY", "PROCESS SUMMARY", "PSYCHOLOGY SUMMARY", "RISK SUMMARY", "DATA QUALITY", "REVIEW POINTS"].forEach(label => expect(written).toContain(label));
    expect(doc.flattened()).toContain("$60.00");
    expect(doc.violations).toEqual([]);
    expect(doc.overlaps()).toEqual([]);
  });

  it("prints the behaviour dataset once and keeps the review page free of tables", async () => {
    const doc = await render([{ trade: completeTrade({ hasScreenshot: false }) }]);
    const written = doc.flattened();
    expect(written).toContain("MISTAKE / RULE-BREAK FREQUENCY");
    expect(written).not.toContain("REPEATED BEHAVIOURAL PATTERNS");
    // Performance, process and psychology tables stay on their own pages.
    const reviewPage = doc.pageOf("Review summary");
    expect(reviewPage).toBeTruthy();
    const reviewText = doc.texts.filter(entry => entry.page === reviewPage).map(entry => entry.text);
    ["SESSION PERFORMANCE", "TIMEFRAME PERFORMANCE", "SETUP PERFORMANCE", "DAILY PERFORMANCE", "PATIENCE DISTRIBUTION", "RECORDED EMOTIONS", "MISTAKE / RULE-BREAK FREQUENCY"]
      .forEach(label => expect(reviewText).not.toContain(label));
  });

  it("lays the review page out in two balanced columns", async () => {
    const doc = await render([{ trade: completeTrade({ hasScreenshot: false }) }]);
    const page = doc.pageOf("Review summary");
    expect(page).toBeTruthy();
    const bullets = doc.texts.filter(entry => entry.page === page && entry.text === "•");
    expect(bullets.filter(entry => entry.x < PDF_PAGE.width / 2).length).toBeGreaterThan(0);
    expect(bullets.filter(entry => entry.x >= PDF_PAGE.width / 2).length).toBeGreaterThan(0);
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

  it("keeps every recorded variant complete: unplanned, break-even, loss, many tags, long psychology", async () => {
    // Long free text: each field carries an unbreakable marker so the assertion is
    // exact even though the value wraps across several lines of a narrow column.
    const longBefore = "Calm before the session, but psyche-marker-before kept pulling me toward a quick revenge entry instead of waiting for the plan to present itself.";
    const longDuring = "Watching price drift, and psyche-marker-during made me want to close early rather than trust the stop I had already placed on the chart.";
    const longAfter = "Resigned rather than satisfied; psyche-marker-after was still there when I reviewed the chart and wrote the journal note for the day.";
    const manyTags = "Revenge|Oversize|Moved SL|Chased entry|Ignored news|Fatigue|Distracted|Late session|No confirmation|FOMO";
    const variants = [
      completeTrade({ id: 1, result: "BREAK_EVEN", pnl: "0.00", planStatus: "UNPLANNED", hasScreenshot: false, notes: "Scratched the setup at break even." }),
      completeTrade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z", result: "LOSS", pnl: "-52.30", planStatus: "PLANNED", hasScreenshot: false, mistake: manyTags, emotionBefore: longBefore, emotionDuring: longDuring, emotionAfter: longAfter }),
      trade({ id: 3, tradeDate: "2026-08-06T09:00:00.000Z", pnl: null, result: "", session: "", direction: "", hasScreenshot: false }),
    ];
    const doc = await render(variants.map(entry => ({ trade: entry })));
    // Unplanned, break-even and losing trades all read the same way as a winner.
    expect(doc.written()).toContain("UNPLANNED");
    expect(doc.flattened()).toContain("Unplanned entry");
    expect(doc.flattened()).toContain("$0.00");
    expect(doc.flattened()).toContain("-$52.30");
    // Every tag and every long emotion field survives, wrapped inside its own row.
    const losing = buildTradePresentation(variants[1]);
    for (const field of losing.sections.filter(section => section.id === "mistakes")[0].fields) {
      expect(appearsIn(doc, field.value), `missing mistake field ${field.label}`).toBe(true);
    }
    ["psyche-marker-before", "psyche-marker-during", "psyche-marker-after"].forEach(marker => {
      expect(doc.written(), `missing long psychology text ${marker}`).toContain(marker);
    });
    // A trade with no optional fields still prints the whole schema with — markers.
    expect(doc.written()).toContain(PRESENTATION_MISSING);
    ["TRADE 01 / 03", "TRADE 02 / 03", "TRADE 03 / 03"].forEach(title => expect(doc.pageOf(title), `missing ${title}`).not.toBeNull());
    expect(doc.violations).toEqual([]);
    expect(doc.overlaps()).toEqual([]);
  });

  it("uses its own light print palette, independent of the application theme", () => {
    expect(PDF_COLORS.page).toEqual([255, 255, 255]);
    expect(PDF_COLORS.ink[0]).toBeLessThan(60);
    expect(PDF_COLORS.positive[1]).toBeGreaterThan(PDF_COLORS.positive[0]);
    expect(PDF_COLORS.negative[0]).toBeGreaterThan(PDF_COLORS.negative[1]);
  });

  it("renders 1, 3 and 50 trades, long text, and empty data without overlap or clipping", async () => {
    const longTags = "Revenge|Oversize|Moved SL|Chased entry|Ignored news|Fatigue|Distracted|Late session|No confirmation|FOMO";
    const longText = Array.from({ length: 12 }, (_, index) => `Segment ${index + 1} records what happened around this part of the session in enough words to wrap across several lines of the report.`).join("\n");
    const datasets: TradeLogPdfTrade[][] = [
      [{ trade: completeTrade({ hasScreenshot: false }) }],
      Array.from({ length: 3 }, (_, index) => ({
        trade: completeTrade({ id: index + 1, tradeDate: `2026-08-0${index + 4}T09:00:00.000Z`, result: ["WIN", "LOSS", "BREAK_EVEN"][index], pnl: ["70.90", "-48.20", "0.00"][index], hasScreenshot: false }),
      })),
      Array.from({ length: 50 }, (_, index) => ({
        trade: completeTrade({ id: index + 1, tradeDate: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T09:00:00.000Z`, result: ["WIN", "LOSS", "BREAK_EVEN"][index % 3], pnl: ["70.90", "-48.20", "0.00"][index % 3], session: ["New York", "London", "Asian"][index % 3], hasScreenshot: false }),
      })),
      [{ trade: completeTrade({ mistake: longTags, emotionBefore: longText, emotionDuring: longText, emotionAfter: longText, notes: longText, hasScreenshot: false }) }],
      [{ trade: trade({ pnl: null, result: "", session: "", symbol: "", level: "", patienceScore: null, planChecklist: null, planStatus: null, notes: null, emotionBefore: null, mistake: null, planChecklist: null, hasScreenshot: false }) }],
    ];
    for (const trades of datasets) {
      const doc = await render(trades);
      const label = `${trades.length} trade(s)`;
      expect(doc.violations, `clipping with ${label}`).toEqual([]);
      expect(doc.overlaps(), `overlap with ${label}`).toEqual([]);
      const total = doc.getNumberOfPages();
      for (let page = 1; page <= total; page += 1) {
        expect(doc.texts.some(entry => entry.page === page), `page ${page} of the ${label} report is empty`).toBe(true);
        expect(doc.contentMaxY(page), `page ${page} of the ${label} report runs past the content area`).toBeLessThanOrEqual(PDF_PAGE.height - 12);
      }
      for (let index = 0; index < trades.length; index += 1) {
        expect(doc.pageOf(`TRADE ${String(index + 1).padStart(2, "0")} / ${String(trades.length).padStart(2, "0")}`), `missing trade page ${index + 1} of ${label}`).not.toBeNull();
      }
      expect(doc.written(), `the ${label} report keeps the full schema`).toContain(PRESENTATION_MISSING);
    }
  });

  it("keeps the reference 9-trade report to exactly two pages per trade plus the analysis", async () => {
    const sessions = ["New York", "London", "Asian", "Pre-London", "New York", "London", "New York", "Asian", "London"];
    const outcomes = ["WIN", "LOSS", "BREAK_EVEN", "WIN", "LOSS", "WIN", "WIN", "LOSS", "WIN"];
    const pnls = ["70.90", "-48.20", "0.00", "134.10", "-52.30", "88.75", "210.40", "-40.00", "61.25"];
    const reference: TradeLogPdfTrade[] = Array.from({ length: 9 }, (_, index) => ({
      trade: completeTrade({
        id: 690 + index,
        tradeDate: `2026-09-${String(16 + Math.floor(index / 3)).padStart(2, "0")}T0${9 + (index % 3)}:15:00.000Z`,
        session: sessions[index], direction: index % 2 ? "SELL" : "BUY", result: outcomes[index], pnl: pnls[index],
        notes: `Waited for the retest at the ${index % 2 ? "H4 supply" : "daily RBS"}, entered on displacement and managed into the target.`,
        screenshotUrl: "https://files.test/chart.png", screenshotName: `evidence-${index + 1}.png`, hasScreenshot: true,
      }), runningBalance: null,
    }));
    const doc = await render(reference);
    expect([doc.pageOf("TRADE 01 / 09"), doc.pageOf("TRADE 05 / 09"), doc.pageOf("TRADE 09 / 09")]).toEqual([1, 9, 17]);
    expect(doc.pagesWithImage()).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
    const total = doc.getNumberOfPages();
    // 18 trade pages, then only the analysis pages: never the three-to-four pages
    // per trade this report replaced.
    expect(total).toBeGreaterThanOrEqual(20);
    expect(total).toBeLessThanOrEqual(24);
    expect(doc.pageOf("Performance overview")).toBe(19);
    expect(doc.violations).toEqual([]);
    expect(doc.overlaps()).toEqual([]);
    // No page is left blank, and no page runs past the content area.
    for (let page = 1; page <= total; page += 1) {
      expect(doc.texts.some(entry => entry.page === page), `page ${page} is empty`).toBe(true);
      expect(doc.contentMaxY(page)).toBeLessThanOrEqual(PDF_PAGE.height - 12);
    }
  });
});

describe("layout validation", () => {
  /** Renders the reference report and hands back its measured layout. */
  async function measure(trades: TradeLogPdfTrade[]) {
    const doc = new RecordingPdfDoc();
    const result = await renderTradeLogPdf(doc, {
      accountName: "Funded Gold",
      rangeLabel: "2026-08-01 to 2026-08-31",
      mode: "ALL_TIME",
      summary: summarizeBulkPdfTrades(trades.map(row => row.trade as never)),
      trades,
      fetchImage: async () => ({ dataUrl: `data:image/png;base64,${PNG_1PX}`, format: "PNG" }),
    });
    return { doc, result };
  }

  it("flags a genuine collision and ignores containers, page breaks, and grazing blocks", () => {
    const rect = (id: string, x: number, y: number, width: number, height: number, kind: PdfLayoutBlock["kind"]): PdfLayoutBlock => ({ id, page: 1, x, y, width, height, kind });
    expect(findLayoutOverlaps([rect("band:A", 12, 10, 100, 4, "band"), rect("text:a", 12, 8, 100, 4, "text")])).toEqual(["band:A intersects text:a on page 1"]);
    expect(findLayoutOverlaps([rect("table:a", 12, 10, 100, 10, "table"), rect("table:b", 12, 15, 100, 10, "table")])).toEqual(["table:a intersects table:b on page 1"]);
    // A panel is a container: its own content is drawn inside it by design.
    expect(findLayoutOverlaps([rect("panel:p", 12, 10, 100, 20, "panel"), rect("text:t", 14, 12, 40, 4, "text")])).toEqual([]);
    // An image is a container too, and a hairline gap is not a collision.
    expect(findLayoutOverlaps([rect("image:i", 12, 10, 100, 20, "image"), rect("text:t", 14, 12, 40, 4, "text")])).toEqual([]);
    expect(findLayoutOverlaps([rect("text:a", 12, 10, 100, 4, "text"), rect("text:b", 12, 14.4, 100, 4, "text")])).toEqual([]);
    expect(findLayoutOverlaps([rect("text:a", 12, 10, 100, 4, "text"), { ...rect("text:b", 12, 10, 100, 4, "text"), page: 2 }])).toEqual([]);
  });

  it("reports no overlapping block anywhere in a full report", async () => {
    const { doc, result } = await measure(Array.from({ length: 9 }, (_, index) => ({
      trade: completeTrade({
        id: 690 + index,
        tradeDate: `2026-09-${String(16 + Math.floor(index / 3)).padStart(2, "0")}T0${9 + (index % 3)}:15:00.000Z`,
        result: ["WIN", "LOSS", "BREAK_EVEN"][index % 3],
        pnl: ["70.90", "-48.20", "0.00"][index % 3],
        hasScreenshot: index % 2 === 0,
        screenshotUrl: index % 2 === 0 ? "https://files.test/chart.png" : null,
      }),
      runningBalance: 1000 + index * 10,
    })));
    expect(result.layout.overlaps).toEqual([]);
    expect(result.layout.blocks.length).toBeGreaterThan(50);
    expect(doc.violations).toEqual([]);
  });

  it("leaves the measured section gap between every band and the content it introduces", async () => {
    const { result } = await measure([{ trade: completeTrade({ hasScreenshot: false }) }]);
    const bands = result.layout.blocks.filter(block => block.kind === "band");
    expect(bands.length).toBeGreaterThan(5);
    let checked = 0;
    for (const band of bands) {
      const content = result.layout.blocks.find(block => block.id === `${band.id}.content`);
      if (!content) continue;
      expect(content.y - (band.y + band.height)).toBeGreaterThanOrEqual(SECTION_GAP - 0.01);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("keeps every coloured band clear of the text around it", async () => {
    const { doc, result } = await measure([
      { trade: completeTrade({ id: 1, hasScreenshot: false }) },
      { trade: completeTrade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z", result: "LOSS", pnl: "-52.30", mistake: "Revenge|Oversize|Moved SL|Chased entry|FOMO", notes: "Closed early after a wide stop, no confirmation on the entry.", hasScreenshot: false }) },
      { trade: completeTrade({ id: 3, tradeDate: "2026-08-06T09:00:00.000Z", result: "BREAK_EVEN", pnl: "0.00", hasScreenshot: false }) },
    ]);
    const bands = result.layout.blocks.filter(block => block.kind === "band");
    expect(bands.length).toBeGreaterThan(10);
    for (const band of bands) {
      for (const entry of doc.texts) {
        if (entry.page !== band.page) continue;
        const width = entry.text.length * entry.size * 0.22;
        const left = entry.align === "center" ? entry.x - width / 2 : entry.align === "right" ? entry.x - width : entry.x;
        const overlapX = Math.min(left + width, band.x + band.width) - Math.max(left, band.x);
        const overlapY = Math.min(entry.y + descent(entry.size), band.y + band.height) - Math.max(entry.y - ascent(entry.size), band.y);
        if (overlapX <= 1 || overlapY <= 0.4) continue;
        // The band's own title is the only text allowed inside a band.
        expect(entry.text.toUpperCase(), `"${entry.text}" must not be drawn inside band ${band.id}`).toBe(band.title);
      }
    }
    expect(result.layout.overlaps).toEqual([]);
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

  it("produces a real jsPDF document whose page count is exactly two pages per trade plus the analysis", async () => {
    const { jsPDF } = await import("jspdf");
    // The real writer, with real Helvetica metrics: this is the acceptance case the
    // reference report describes — nine trades, eighteen trade pages, then analysis.
    const reference: TradeLogPdfTrade[] = Array.from({ length: 9 }, (_, index) => ({
      trade: completeTrade({
        id: 690 + index,
        tradeDate: `2026-09-${String(16 + Math.floor(index / 3)).padStart(2, "0")}T0${9 + (index % 3)}:15:00.000Z`,
        session: ["New York", "London", "Asian"][index % 3],
        direction: index % 2 ? "SELL" : "BUY",
        result: index % 3 === 1 ? "LOSS" : "WIN",
        pnl: index % 3 === 1 ? "-48.20" : "70.90",
        screenshotUrl: index === 2 ? null : "https://files.test/chart.png",
        hasScreenshot: index !== 2,
        notes: index === 4
          ? Array.from({ length: 26 }, (_, p) => `Paragraph ${p + 1}: the journal entry continues with enough words to wrap across several lines in the generated document.`).join("\n")
          : "Waited for the retest at the daily RBS, entered on displacement and managed into the target.",
      }),
      runningBalance: 1000 + index,
    }));
    const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });
    const result = await renderTradeLogPdf(doc, {
      accountName: "Blueberry live",
      rangeLabel: "2026-09-16 to 2026-09-18",
      mode: "ALL_TIME",
      summary: summarizeBulkPdfTrades(reference.map(row => row.trade as never)),
      trades: reference,
      fetchImage: async () => ({ dataUrl: `data:image/png;base64,${PNG_1PX}`, format: "PNG" }),
    });
    const bytes = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
    // 18 trade pages. One trade carries a 26-paragraph entry and correctly takes a
    // labelled continuation page, so the document is 19-21 pages plus the analysis.
    expect(result.pages).toBeGreaterThanOrEqual(22);
    expect(result.pages).toBeLessThanOrEqual(25);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(bytes.byteLength).toBeGreaterThan(20_000);
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(297, 0);
    expect(doc.internal.pageSize.getHeight()).toBeCloseTo(210, 0);
  });

  it("keeps two trades to two data pages and two evidence pages", async () => {
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
    // Two data pages, two evidence pages, then the analysis pages (never less than
    // the four the report structure defines).
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(8);
    expect(doc.getNumberOfPages()).toBeLessThanOrEqual(12);
  });
});
