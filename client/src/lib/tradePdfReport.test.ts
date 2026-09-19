import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeBulkPdfTrades } from "./bulkPdf";
import { SCREENSHOT_EMBED_FAILURE, detectImageFormat, fetchPdfImage, renderTradeLogPdf, type PdfDoc, type PdfImage, type TradeLogPdfTrade } from "./tradePdfReport";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type TextCall = { text: string; x: number; y: number; size: number; page: number };
type ImageCall = { format: string; x: number; y: number; width: number; height: number; page: number; dataUrl: string };

/** A jsPDF-shaped recorder: it validates page bounds the way the real writer must. */
class RecordingPdfDoc implements PdfDoc {
  texts: TextCall[] = [];
  images: ImageCall[] = [];
  violations: string[] = [];
  private page = 1;
  private fontSize = 10;
  private dimensions = new Map<string, { width: number; height: number }>();

  withDimensions(dataUrl: string, width: number, height: number) { this.dimensions.set(dataUrl, { width, height }); return this; }
  addPage() { this.page += 1; return this; }
  getNumberOfPages() { return this.page; }
  setFillColor() { return this; }
  setTextColor() { return this; }
  setFontSize(size: number) { this.fontSize = size; return this; }
  rect() { return this; }
  roundedRect() { return this; }
  text(value: string | string[], x: number, y: number) {
    for (const line of Array.isArray(value) ? value : [value]) {
      this.texts.push({ text: line, x, y, size: this.fontSize, page: this.page });
      if (y < 0 || y > 297 || x < 0 || x > 210) this.violations.push(`text out of bounds: ${line}`);
    }
    return this;
  }
  splitTextToSize(text: string, maxWidth: number) {
    // ≈0.18 mm per character per point is a realistic Helvetica width.
    const perLine = Math.max(8, Math.floor(maxWidth / (this.fontSize * 0.18)));
    const lines: string[] = [];
    let current = "";
    for (const word of text.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > perLine && current) { lines.push(current); current = word; } else current = candidate;
    }
    if (current) lines.push(current);
    return lines.length ? lines : [""];
  }
  addImage(dataUrl: string, format: string, x: number, y: number, width: number, height: number) {
    this.images.push({ dataUrl, format, x, y, width, height, page: this.page });
    if (y < 0 || y + height > 297 || x < 0 || x + width > 210) this.violations.push(`image out of bounds: ${format}`);
    return this;
  }
  getImageProperties(dataUrl: string) { return this.dimensions.get(dataUrl) ?? { width: 1600, height: 900 }; }
  written() { return this.texts.map(entry => entry.text).join("\n"); }
  /** Wrapping-insensitive view of the page text, for content assertions. */
  flattened() { return this.written().replace(/\s+/g, " "); }
}

const trade = (overrides: Record<string, unknown> = {}) => ({ id: 1, accountId: 3, tradeDate: "2026-08-04T09:00:00.000Z", pnl: "10.00", result: "WIN", session: "London", direction: "BUY", ...overrides });

async function render(trades: TradeLogPdfTrade[], options: { fetchImage?: (url: string) => Promise<PdfImage>; accountName?: string; rangeLabel?: string } = {}) {
  const doc = new RecordingPdfDoc();
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

describe("trade log PDF report", () => {
  it("wraps very long journal notes across additional pages instead of truncating them", async () => {
    const notes = Array.from({ length: 120 }, (_, index) => `Paragraph ${index + 1} of the journal entry with enough words to wrap across several lines in the generated document.`).join("\n");
    const doc = await render([{ trade: trade({ notes, emotionBefore: "calm", emotionDuring: "focused", emotionAfter: "satisfied" }) }]);
    expect(doc.getNumberOfPages()).toBeGreaterThan(3);
    const written = doc.written();
    for (const index of [1, 2, 40, 119, 120]) expect(written).toContain(`Paragraph ${index} of`);
    expect(doc.flattened()).toContain("Trade 01 / 01 — continued");
  });

  it("embeds a screenshot with its real format, preserving its aspect ratio inside the page", async () => {
    const doc = await render([{ trade: trade({ screenshotUrl: "https://files.test/chart.png", screenshotName: "chart.png", hasScreenshot: true }) }]);
    const heading = doc.texts.find(entry => entry.text === "SCREENSHOT EVIDENCE");
    expect(doc.flattened()).toContain("File name: chart.png");
    expect(heading, "the screenshot section must have a clear heading").toBeTruthy();
    const image = doc.images[0];
    expect(doc.images).toHaveLength(1);
    expect(image.format).toBe("PNG");
    expect(image.x).toBe(15);
    expect(image.page).toBe(heading?.page);
    expect(image.width).toBeCloseTo(180, 1);
    expect(image.width / image.height).toBeCloseTo(1600 / 900, 2);
    expect(image.y + image.height).toBeLessThanOrEqual(282.001);
    expect(doc.violations).toEqual([]);
  });

  it("scales a tall screenshot down proportionally instead of cropping it", async () => {
    const dataUrl = `data:image/png;base64,${PNG_1PX}`;
    const tallDoc = new RecordingPdfDoc().withDimensions(dataUrl, 600, 2400);
    await renderTradeLogPdf(tallDoc, {
      accountName: "Funded Gold", rangeLabel: "2026-08-01 to 2026-08-31", mode: "ALL_TIME",
      summary: summarizeBulkPdfTrades([]),
      trades: [{ trade: trade({ screenshotUrl: "https://files.test/tall.png", screenshotName: "tall.png", hasScreenshot: true }) }],
      fetchImage: async () => ({ dataUrl, format: "PNG" }),
    });
    const image = tallDoc.images[0];
    expect(image.width / image.height).toBeCloseTo(600 / 2400, 3);
    expect(image.height).toBeGreaterThan(150);
    expect(image.y + image.height).toBeLessThanOrEqual(282.001);
    expect(tallDoc.violations).toEqual([]);
  });

  it("keeps generating the report when a screenshot cannot be fetched", async () => {
    const doc = await render(
      [{ trade: trade({ screenshotUrl: "https://files.test/broken.png", screenshotName: "broken-entry.png", hasScreenshot: true, notes: "Journal marker UNIQUE-NOTE-42" }) }],
      { fetchImage: async () => { throw new Error("Screenshot request failed with 403"); } }
    );
    expect(doc.images).toHaveLength(0);
    expect(doc.flattened()).toContain(SCREENSHOT_EMBED_FAILURE);
    expect(doc.flattened()).toContain("broken-entry.png");
    expect(doc.flattened()).toContain("UNIQUE-NOTE-42");
    // The report still finishes: the daily P&L page is written after the trade cards.
    expect(doc.flattened()).toContain("P&L CALENDAR");
  });

  it("gives every trade its own screenshot on its own page", async () => {
    const formats: Record<string, string> = {
      "https://files.test/a.png": "PNG",
      "https://files.test/b.jpg": "JPEG",
      "https://files.test/c.webp": "WEBP",
    };
    const doc = await render([
      { trade: trade({ id: 1, screenshotUrl: "https://files.test/a.png", screenshotName: "a.png", hasScreenshot: true }) },
      { trade: trade({ id: 2, tradeDate: "2026-08-05T09:00:00.000Z", screenshotUrl: "https://files.test/b.jpg", screenshotName: "b.jpg", hasScreenshot: true }) },
      { trade: trade({ id: 3, tradeDate: "2026-08-06T09:00:00.000Z", screenshotUrl: "https://files.test/c.webp", screenshotName: "c.webp", hasScreenshot: true }) },
    ], { fetchImage: async url => ({ dataUrl: `data:image/x;base64,${PNG_1PX}`, format: formats[url] }) });
    expect(doc.images.map(image => image.format)).toEqual(["PNG", "JPEG", "WEBP"]);
    expect(doc.images.every(image => image.page >= 2)).toBe(true);
    expect(doc.images[1].page).toBeGreaterThan(doc.images[0].page);
    expect(doc.images[2].page).toBeGreaterThan(doc.images[1].page);
    ["Trade 01 / 03", "Trade 02 / 03", "Trade 03 / 03"].forEach(heading => expect(doc.written()).toContain(heading));
  });

  it("renders — for fields that exist but were never recorded", async () => {
    const doc = await render([{ trade: trade({ pnl: null, result: "", session: "", level: "", mt5Ticket: null, patienceScore: null }) }]);
    const written = doc.written();
    ["SYMBOL", "MT5 TICKET", "PLANNED RISK", "PRE-TRADE CHECKLIST", "PLANNED / UNPLANNED"].forEach(label => expect(written).toContain(label));
    expect(written).toContain("—");
    expect(doc.flattened()).toContain("No screenshot was saved with this trade.");
    expect(doc.violations).toEqual([]);
  });

  it("builds the summary and the daily P&L calendar from the exported trades only", async () => {
    const trades: TradeLogPdfTrade[] = [
      { trade: trade({ id: 1, pnl: "100.00", result: "WIN", tradeDate: "2026-08-01T09:00:00.000Z" }) },
      { trade: trade({ id: 2, pnl: "-40.00", result: "LOSS", tradeDate: "2026-08-01T10:00:00.000Z" }) },
      { trade: trade({ id: 3, pnl: "0.00", result: "BREAK_EVEN", tradeDate: "2026-08-02T09:00:00.000Z" }) },
      { trade: trade({ id: 4, pnl: "25.00", result: "OPEN", tradeDate: "2026-08-03T09:00:00.000Z" }) },
    ];
    const doc = await render(trades);
    const written = doc.written();
    expect(written).toContain("Break-even trades: 1");
    expect(written).toContain("Open trades: 1");
    expect(written).toContain("Wins / Losses");
    expect(doc.texts.filter(entry => entry.text === "2026-08-01")).toHaveLength(1);
    expect(doc.texts.filter(entry => entry.text === "2026-08-02")).toHaveLength(1);
    expect(doc.texts.filter(entry => entry.text === "2026-08-03")).toHaveLength(1);
    expect(doc.texts.filter(entry => entry.text === "$60.00").length).toBeGreaterThan(0);
    expect(doc.violations).toEqual([]);
  });

  it("produces a real multi-page jsPDF document", async () => {
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    await renderTradeLogPdf(doc, {
      accountName: "Funded Gold",
      rangeLabel: "2026-08-01 to 2026-08-31",
      mode: "ALL_TIME",
      summary: summarizeBulkPdfTrades([trade() as never]),
      trades: [{ trade: trade({ notes: "Real document note", screenshotUrl: "https://files.test/chart.png", screenshotName: "chart.png", hasScreenshot: true }), runningBalance: 1250 }],
      fetchImage: async () => ({ dataUrl: `data:image/png;base64,${PNG_1PX}`, format: "PNG" }),
    });
    const bytes = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(4);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(bytes.byteLength).toBeGreaterThan(5_000);
  });

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

    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(webp, { status: 200, headers: { "content-type": "image/webp" } })));
    const converted = await fetchPdfImage("https://files.test/chart.webp");
    expect(converted.format).toBe("WEBP");
    expect(converted.dataUrl.startsWith("data:image/webp;base64,")).toBe(true);
  });
});
