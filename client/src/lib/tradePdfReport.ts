/**
 * The PDF report writer.
 *
 * It lays out the canonical model from `tradePdfModel` on A4 pages and never
 * decides what a trade contains: every section, field, emotion, note, and
 * screenshot it draws came from that one model. It takes a `PdfDoc` instead of a
 * concrete jsPDF instance so the layout and pagination rules can be tested
 * without a browser, while the app passes a real jsPDF document.
 *
 * Everything is paginated: a trade continues on as many pages as its data needs
 * (`Trade 04 / 27 — continued`), long notes wrap, and a screenshot that does not
 * fit moves to a continuation page instead of being cropped or shrunk into
 * unreadable text. The document has its own fixed light-on-dark print colors, so
 * the application theme (light or dark) cannot change how the export reads.
 */

import { formatMoney, toNumber } from "./gold";
import { PDF_MISSING, buildTradePdfModel, type TradePdfField, type TradePdfModel } from "./tradePdfModel";
import type { BulkPdfSummary } from "./bulkPdf";

export type PdfImage = { dataUrl: string; format: string };

/** The slice of jsPDF this writer needs; a real jsPDF document satisfies it. */
export type PdfDoc = {
  addPage(): unknown;
  getNumberOfPages(): number;
  setFillColor(red: number, green: number, blue: number): unknown;
  setTextColor(red: number, green: number, blue: number): unknown;
  setFontSize(size: number): unknown;
  setFont?(name: string, style?: string): unknown;
  rect(x: number, y: number, width: number, height: number, style?: string): unknown;
  roundedRect(x: number, y: number, width: number, height: number, radiusX: number, radiusY: number, style?: string): unknown;
  text(text: string | string[], x: number, y: number): unknown;
  splitTextToSize(text: string, maxWidth: number): string[];
  addImage(dataUrl: string, format: string, x: number, y: number, width: number, height: number): unknown;
  getImageProperties(dataUrl: string): { width: number; height: number };
};

export const PDF_PAGE = { width: 210, height: 297, margin: 15 };
export const PDF_COLORS = {
  bg: [16, 20, 26],
  panel: [25, 32, 41],
  gold: [233, 182, 75],
  text: [235, 240, 245],
  muted: [146, 159, 171],
  green: [83, 188, 137],
  red: [222, 104, 98],
  line: [44, 55, 68],
} as const;

export const SCREENSHOT_EMBED_FAILURE = "Screenshot evidence could not be embedded during export.";

type Rgb = readonly [number, number, number];

type Header = { eyebrow: string; title: string; titleSize: number; continuedTitle: string };

type Ctx = {
  doc: PdfDoc;
  y: number;
  header: Header;
  headerHeight: number;
  bodyTop: number;
  bottom: number;
  contentWidth: number;
};

function setFill(doc: PdfDoc, color: Rgb) { doc.setFillColor(color[0], color[1], color[2]); }
function setText(doc: PdfDoc, color: Rgb) { doc.setTextColor(color[0], color[1], color[2]); }

function paintBackground(doc: PdfDoc) {
  setFill(doc, PDF_COLORS.bg);
  doc.rect(0, 0, PDF_PAGE.width, PDF_PAGE.height, "F");
}

/**
 * Draws the page header (eyebrow, title up to two wrapped lines, rule) and
 * returns the exact height it used, so no page loses space it does not need and
 * the title can never collide with the body.
 */
function drawHeader(doc: PdfDoc, header: Header, title: string): number {
  const margin = PDF_PAGE.margin;
  setText(doc, PDF_COLORS.gold);
  doc.setFontSize(7.5);
  doc.text(header.eyebrow, margin, margin + 4);
  setText(doc, PDF_COLORS.text);
  doc.setFontSize(header.titleSize);
  const lines = doc.splitTextToSize(title, PDF_PAGE.width - margin * 2).slice(0, 2);
  const advance = header.titleSize * 0.42;
  const firstBaseline = margin + 4 + header.titleSize * 0.5;
  lines.forEach((line, index) => doc.text(line, margin, firstBaseline + index * advance));
  const ruleY = firstBaseline + Math.max(0, lines.length - 1) * advance + 2.6;
  setFill(doc, PDF_COLORS.gold);
  doc.rect(margin, ruleY, 26, 0.7, "F");
  return ruleY - margin + 4;
}

function startPage(doc: PdfDoc, header: Header): Ctx {
  paintBackground(doc);
  const headerHeight = drawHeader(doc, header, header.title);
  return {
    doc,
    header,
    headerHeight,
    bodyTop: PDF_PAGE.margin + headerHeight,
    bottom: PDF_PAGE.height - PDF_PAGE.margin,
    contentWidth: PDF_PAGE.width - PDF_PAGE.margin * 2,
    y: PDF_PAGE.margin + headerHeight,
  };
}

/** Adds a page, repaints the background, and restores the trade's context. */
function newPage(ctx: Ctx, continued = true) {
  ctx.doc.addPage();
  paintBackground(ctx.doc);
  ctx.headerHeight = drawHeader(ctx.doc, ctx.header, continued ? ctx.header.continuedTitle : ctx.header.title);
  ctx.bodyTop = PDF_PAGE.margin + ctx.headerHeight;
  ctx.y = ctx.bodyTop;
}

/** Starts a new page when `needed` millimetres no longer fit above the margin. */
function ensureSpace(ctx: Ctx, needed: number) {
  if (ctx.y + needed > ctx.bottom) newPage(ctx);
}

/** Writes wrapped text line by line, continuing onto new pages as needed. */
function writeLines(ctx: Ctx, value: unknown, options: { x?: number; lineHeight?: number; maxWidth?: number; color?: Rgb } = {}) {
  const x = options.x ?? PDF_PAGE.margin;
  const lineHeight = options.lineHeight ?? 4.5;
  const maxWidth = options.maxWidth ?? ctx.contentWidth;
  if (options.color) setText(ctx.doc, options.color);
  const paragraphs = String(value ?? "").split("\n");
  for (const paragraph of paragraphs) {
    const lines = paragraph.trim() === "" ? [""] : ctx.doc.splitTextToSize(paragraph, maxWidth) as string[];
    for (const line of lines) {
      ensureSpace(ctx, lineHeight);
      ctx.doc.text(line, x, ctx.y);
      ctx.y += lineHeight;
    }
  }
}

function sectionHeading(ctx: Ctx, title: string) {
  ensureSpace(ctx, 12);
  setText(ctx.doc, PDF_COLORS.gold);
  ctx.doc.setFontSize(9);
  ctx.doc.text(title.toUpperCase(), PDF_PAGE.margin, ctx.y);
  ctx.y += 2.4;
  setFill(ctx.doc, PDF_COLORS.line);
  ctx.doc.rect(PDF_PAGE.margin, ctx.y, ctx.contentWidth, 0.4, "F");
  ctx.y += 5;
}

function valueColor(label: string, value: string): Rgb {
  const negative = value.trim().startsWith("-");
  if (label.includes("P&L") || label.includes("R:R") || label === "Actual R" || label === "Running balance") return negative ? PDF_COLORS.red : PDF_COLORS.green;
  return PDF_COLORS.text;
}

/**
 * One labelled field: the label on its own line, then the complete value wrapped
 * across as many lines (and pages) as it needs. No clipping, no overlap.
 */
function addTradeFieldGrid(ctx: Ctx, fields: TradePdfField[]) {
  for (const field of fields) {
    const color = valueColor(field.label, field.value);
    ensureSpace(ctx, 9);
    setText(ctx.doc, PDF_COLORS.muted);
    ctx.doc.setFontSize(7.5);
    ctx.doc.text(field.label.toUpperCase(), PDF_PAGE.margin, ctx.y);
    ctx.y += 3.8;
    ctx.doc.setFontSize(9.5);
    writeLines(ctx, field.value, { lineHeight: 4.6, color });
    ctx.y += 2.4;
  }
}

function addSection(ctx: Ctx, section: { title: string; fields: TradePdfField[] }) {
  sectionHeading(ctx, section.title);
  addTradeFieldGrid(ctx, section.fields);
}

function addParagraph(ctx: Ctx, heading: string | null, text: string, color: Rgb = PDF_COLORS.text) {
  if (heading) sectionHeading(ctx, heading);
  ctx.doc.setFontSize(9.5);
  writeLines(ctx, text.trim() === "" ? PDF_MISSING : text, { lineHeight: 4.6, color });
}

function addWarning(ctx: Ctx, detail: string) {
  ctx.doc.setFontSize(9);
  writeLines(ctx, SCREENSHOT_EMBED_FAILURE, { lineHeight: 4.6, color: PDF_COLORS.red });
  writeLines(ctx, detail, { lineHeight: 4.4, color: PDF_COLORS.muted });
}

/* ------------------------------------------------------------------ *
 * Screenshot evidence
 * ------------------------------------------------------------------ */

/** Detects the real image format from magic bytes rather than assuming JPEG. */
export function detectImageFormat(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "PNG";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "JPEG";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "WEBP";
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "GIF";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "BMP";
  return null;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    const slice = bytes.subarray(index, index + chunk);
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

/** Browser-only WEBP → PNG upgrade; returns the input unchanged when unavailable. */
async function toPngDataUrl(dataUrl: string): Promise<string | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Screenshot could not be decoded"));
      element.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) return null;
    context.drawImage(image, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * Fetches a screenshot and prepares it for jsPDF: the format comes from the
 * bytes, and a WEBP is converted to PNG in the browser when canvas is available
 * so every viewer renders it.
 */
export async function fetchPdfImage(url: string): Promise<PdfImage> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Screenshot request failed with ${response.status}`);
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const detected = detectImageFormat(bytes) ?? (blob.type.includes("png") ? "PNG" : blob.type.includes("jpeg") ? "JPEG" : "PNG");
  const dataUrl = `data:${blob.type || "image/png"};base64,${base64(bytes)}`;
  if (detected === "WEBP") {
    const converted = await toPngDataUrl(dataUrl);
    if (converted) return { dataUrl: converted, format: "PNG" };
  }
  return { dataUrl, format: detected };
}

const SCREENSHOT_METADATA_LINES = 3;
const SCREENSHOT_HEADING_BLOCK = 8 + SCREENSHOT_METADATA_LINES * 4.2 + 2;
const SCREENSHOT_CAPTION_BLOCK = 6;

async function addScreenshot(ctx: Ctx, model: TradePdfModel, fetchImage: (url: string) => Promise<PdfImage>) {
  const metadata = [
    `File name: ${model.evidence.filename ?? PDF_MISSING}`,
    `Screenshot stored with trade: ${model.evidence.hasScreenshot ? "Yes" : "No"}`,
    `Export link at build time: ${model.evidence.url ? "Available" : "Unavailable"}`,
  ].join("\n");
  const writeMetadata = () => {
    sectionHeading(ctx, "Screenshot evidence");
    ctx.doc.setFontSize(8.5);
    writeLines(ctx, metadata, { lineHeight: 4.2, color: PDF_COLORS.muted });
    ctx.y += 2;
  };

  if (!model.evidence.url) {
    ensureSpace(ctx, SCREENSHOT_HEADING_BLOCK + 6);
    writeMetadata();
    if (model.evidence.hasScreenshot) addWarning(ctx, `A screenshot is recorded for this trade but no export link was available at export time. File name: ${model.evidence.filename ?? "unknown"}.`);
    else writeLines(ctx, "No screenshot was saved with this trade.", { lineHeight: 4.4, color: PDF_COLORS.muted });
    return;
  }

  try {
    // The image is fetched and measured first, so the heading, its metadata, and
    // the image always land on the same page and never overflow it.
    const image = await fetchImage(model.evidence.url);
    const properties = ctx.doc.getImageProperties(image.dataUrl);
    const width = Number(properties?.width);
    const height = Number(properties?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("Screenshot dimensions could not be read");
    const availableHeight = ctx.bottom - ctx.bodyTop - SCREENSHOT_HEADING_BLOCK - SCREENSHOT_CAPTION_BLOCK;
    if (availableHeight <= 0) throw new Error("No page space is available for the screenshot");
    // Contain, never stretch: the aspect ratio is preserved and the image is
    // scaled down to fit, so nothing is cropped and nothing leaves the page.
    const scale = Math.min(ctx.contentWidth / width, availableHeight / height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    ensureSpace(ctx, SCREENSHOT_HEADING_BLOCK + drawHeight + SCREENSHOT_CAPTION_BLOCK);
    writeMetadata();
    ctx.doc.addImage(image.dataUrl, image.format, PDF_PAGE.margin, ctx.y, drawWidth, drawHeight);
    ctx.y += drawHeight + 3;
    ctx.doc.setFontSize(8);
    writeLines(ctx, `Embedded at ${Math.round(drawWidth)} × ${Math.round(drawHeight)} mm (${image.format}), original ${width} × ${height} px.`, { lineHeight: 4, color: PDF_COLORS.muted });
  } catch (error: any) {
    // A single unreadable image never aborts the report: the trade's other
    // fields are already written and the next trade is rendered normally.
    ensureSpace(ctx, SCREENSHOT_HEADING_BLOCK + 10);
    writeMetadata();
    addWarning(ctx, `File name: ${model.evidence.filename ?? "unknown"}. Export link could not be read (${error?.message ?? "unavailable"}). Every other field of this trade is unaffected.`);
  }
}

/* ------------------------------------------------------------------ *
 * Pages
 * ------------------------------------------------------------------ */

export type TradeLogPdfTrade = { trade: Record<string, unknown>; runningBalance?: number | null };

export type TradeLogPdfOptions = {
  accountName: string;
  rangeLabel: string;
  mode: "ALL_TIME" | "RANGE";
  summary: BulkPdfSummary;
  trades: TradeLogPdfTrade[];
  fetchImage?: (url: string) => Promise<PdfImage>;
};

function summaryCard(ctx: Ctx, label: string, value: string, x: number, y: number) {
  const doc = ctx.doc;
  setText(doc, PDF_COLORS.muted);
  doc.setFontSize(8);
  doc.text(label, x, y);
  setText(doc, PDF_COLORS.text);
  doc.setFontSize(13);
  doc.text(doc.splitTextToSize(value, 41)[0] ?? "", x, y + 8);
}

function renderSummary(ctx: Ctx, options: TradeLogPdfOptions) {
  const doc = ctx.doc;
  const summary = options.summary;
  ctx.doc.setFontSize(10);
  writeLines(ctx, options.mode === "ALL_TIME" ? `Whole trade log · ${options.rangeLabel}` : `Selected period · ${options.rangeLabel}`, { lineHeight: 4.6, color: PDF_COLORS.muted });
  ctx.y += 4;
  setFill(doc, PDF_COLORS.panel);
  doc.roundedRect(PDF_PAGE.margin, ctx.y, ctx.contentWidth, 40, 4, 4, "F");
  const cardsY = ctx.y + 10;
  summaryCard(ctx, "Trades", String(summary.total), PDF_PAGE.margin + 7, cardsY);
  summaryCard(ctx, "Net P&L", formatMoney(summary.pnl), PDF_PAGE.margin + 52, cardsY);
  summaryCard(ctx, "Win rate", `${summary.winRate.toFixed(1)}%`, PDF_PAGE.margin + 97, cardsY);
  summaryCard(ctx, "Wins / Losses", `${summary.wins} / ${summary.losses}`, PDF_PAGE.margin + 142, cardsY);
  ctx.y += 48;
  ctx.doc.setFontSize(9);
  writeLines(ctx, [
    `Account: ${options.accountName}`,
    `Selected date range: ${options.rangeLabel}`,
    `Break-even trades: ${summary.breakEven}`,
    `Open trades: ${summary.open}`,
  ].join("\n"), { lineHeight: 5, color: PDF_COLORS.text });
  ctx.y += 3;
  ctx.doc.setFontSize(9);
  writeLines(ctx, "This report is the complete archival copy of the selected trade log: every trade card below carries all recorded fields, the linked screenshot evidence when available, then the period analysis and daily P&L calendar. Only the active account is included.", { lineHeight: 4.6, color: PDF_COLORS.muted });
}

async function renderTradeCard(ctx: Ctx, model: TradePdfModel, index: number, total: number, fetchImage: (url: string) => Promise<PdfImage>) {
  const position = `Trade ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
  ctx.header = {
    eyebrow: "GOLD JOURNAL · TRADE CARD",
    title: `${position} · ${model.tradeDate} · ${model.direction} · ${model.result}`,
    titleSize: 14,
    continuedTitle: `${position} — continued`,
  };
  newPage(ctx, false);

  // Header band: the at-a-glance figures, repeated on every continuation page.
  const bandHeight = 22;
  ensureSpace(ctx, bandHeight + 4);
  setFill(ctx.doc, PDF_COLORS.panel);
  ctx.doc.roundedRect(PDF_PAGE.margin, ctx.y, ctx.contentWidth, bandHeight, 3, 3, "F");
  const bandY = ctx.y + 8;
  const cells: Array<[string, string, Rgb]> = [
    ["Trade ID", model.idLabel, PDF_COLORS.text],
    ["Symbol", model.symbol, PDF_COLORS.text],
    ["Session", model.session, PDF_COLORS.text],
    ["P&L", model.pnl, model.pnlValue < 0 ? PDF_COLORS.red : PDF_COLORS.green],
  ];
  ctx.doc.setFontSize(7.5);
  cells.forEach(([label, value, color], cellIndex) => {
    const x = PDF_PAGE.margin + 5 + cellIndex * 45;
    setText(ctx.doc, PDF_COLORS.muted);
    ctx.doc.text(label.toUpperCase(), x, bandY);
    setText(ctx.doc, color);
    ctx.doc.setFontSize(11);
    ctx.doc.text(ctx.doc.splitTextToSize(value, 41)[0] ?? PDF_MISSING, x, bandY + 7.5);
    ctx.doc.setFontSize(7.5);
  });
  ctx.y += bandHeight + 6;

  for (const section of model.sections) addSection(ctx, section);

  sectionHeading(ctx, "Psychology");
  addParagraph(ctx, "Before trade", model.psychology.before);
  addParagraph(ctx, "During trade", model.psychology.during);
  addParagraph(ctx, "After trade", model.psychology.after);

  addParagraph(ctx, "Journal notes", model.journalNotes);

  if (model.additionalFields.length) addSection(ctx, { title: "Additional recorded fields", fields: model.additionalFields });

  await addScreenshot(ctx, model, fetchImage);
}

function renderAnalysis(ctx: Ctx, options: TradeLogPdfOptions) {
  ctx.header = { eyebrow: "GOLD JOURNAL · PRIVATE PERFORMANCE REPORT", title: "Selected-period analysis", titleSize: 20, continuedTitle: "Selected-period analysis (continued)" };
  newPage(ctx, false);

  const sessions = new Map<string, { pnl: number; count: number }>();
  for (const row of options.trades) {
    const session = String((row.trade as { session?: unknown }).session ?? "").trim() || "Unspecified";
    const entry = sessions.get(session) ?? { pnl: 0, count: 0 };
    entry.pnl += toNumber((row.trade as { pnl?: unknown }).pnl);
    entry.count += 1;
    sessions.set(session, entry);
  }
  sectionHeading(ctx, "Net P&L by session");
  ctx.doc.setFontSize(9.5);
  for (const [session, entry] of Array.from(sessions.entries())) {
    ensureSpace(ctx, 6);
    setText(ctx.doc, PDF_COLORS.text);
    ctx.doc.text(ctx.doc.splitTextToSize(session, 90)[0] ?? "", PDF_PAGE.margin, ctx.y);
    setText(ctx.doc, entry.pnl >= 0 ? PDF_COLORS.green : PDF_COLORS.red);
    ctx.doc.text(formatMoney(entry.pnl), 120, ctx.y);
    setText(ctx.doc, PDF_COLORS.muted);
    ctx.doc.text(`${entry.count} trade${entry.count === 1 ? "" : "s"}`, 155, ctx.y);
    ctx.y += 6;
  }
  ctx.y += 4;
  sectionHeading(ctx, "Review prompts");
  addParagraph(ctx, null, `• ${options.summary.winRate.toFixed(1)}% win rate across ${options.summary.total} selected trades.\n• Net period P&L: ${formatMoney(options.summary.pnl)}.\n• Break-even ${options.summary.breakEven} · open ${options.summary.open}.\n• Review the trade cards for repeated session, risk, and emotional patterns.`);
}

function renderDailyPnl(ctx: Ctx, options: TradeLogPdfOptions) {
  ctx.header = { eyebrow: "GOLD JOURNAL · PRIVATE PERFORMANCE REPORT", title: "Daily performance", titleSize: 20, continuedTitle: "Daily performance (continued)" };
  newPage(ctx, false);

  // One pass over the exported trades builds the only daily figure in the file.
  const daily = new Map<string, { pnl: number; count: number }>();
  for (const row of options.trades) {
    const trade = row.trade as { tradeDate?: unknown; pnl?: unknown };
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(trade.tradeDate as string));
    const entry = daily.get(day) ?? { pnl: 0, count: 0 };
    entry.pnl += toNumber(trade.pnl);
    entry.count += 1;
    daily.set(day, entry);
  }
  const entries = Array.from(daily.entries()).sort(([a], [b]) => a.localeCompare(b));

  sectionHeading(ctx, "P&L calendar");
  setText(ctx.doc, PDF_COLORS.muted);
  ctx.doc.setFontSize(9);
  ctx.doc.text("Selected date", PDF_PAGE.margin, ctx.y);
  ctx.doc.text("Trades", 110, ctx.y);
  ctx.doc.text("Daily P&L", 148, ctx.y);
  ctx.y += 8;
  ctx.doc.setFontSize(9.5);
  for (const [day, entry] of Array.from(entries)) {
    ensureSpace(ctx, 6);
    setText(ctx.doc, PDF_COLORS.text);
    ctx.doc.text(day, PDF_PAGE.margin, ctx.y);
    ctx.doc.text(String(entry.count), 110, ctx.y);
    setText(ctx.doc, entry.pnl >= 0 ? PDF_COLORS.green : PDF_COLORS.red);
    ctx.doc.text(formatMoney(entry.pnl), 148, ctx.y);
    ctx.y += 6;
  }
}

/**
 * Renders the whole report: summary page, one complete card per trade (with its
 * screenshot), the period analysis, and the daily P&L calendar — all from the
 * same exported trade set.
 */
export async function renderTradeLogPdf(doc: PdfDoc, options: TradeLogPdfOptions) {
  const ctx = startPage(doc, { eyebrow: "GOLD JOURNAL · PRIVATE PERFORMANCE REPORT", title: options.accountName, titleSize: 20, continuedTitle: `${options.accountName} · export (continued)` });
  renderSummary(ctx, options);
  const fetchImage = options.fetchImage ?? fetchPdfImage;
  for (let index = 0; index < options.trades.length; index += 1) {
    const row = options.trades[index];
    const model = buildTradePdfModel(row.trade, { runningBalance: row.runningBalance ?? null });
    await renderTradeCard(ctx, model, index, options.trades.length, fetchImage);
  }
  renderAnalysis(ctx, options);
  renderDailyPnl(ctx, options);
  return { pages: doc.getNumberOfPages() };
}
