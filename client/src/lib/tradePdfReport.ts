/**
 * The PDF report writer.
 *
 * Layout contract (the report is a fixed, deliberately constructed document, not
 * a flowing one):
 *   • A4 landscape, so a complete trade table fits across the page width;
 *   • exactly two pages per trade — a compact complete-data table and a
 *     screenshot evidence page;
 *   • a compact period analysis after the trades, whose numbers all come from
 *     `@shared/analysisEngine` (see `tradePdfAnalysis`);
 *   • a footer on every page with the account, the period, and `Page X / Y`.
 *
 * It never decides what a trade contains: every value it draws comes from
 * `buildTradePdfModel`. Long values are wrapped inside their cell and a value
 * that genuinely cannot fit continues onto a continuation page — nothing is
 * truncated to make the layout work. Font size shrinks through three readable
 * tiers (down to ~7pt, never smaller) before any overflow is allowed, so an
 * ordinary trade stays on one data page.
 *
 * A `PdfDoc` is passed in rather than a concrete jsPDF instance, so the layout,
 * pagination, and screenshot fitting rules are unit-testable in Node while the
 * application passes a real jsPDF document.
 */

import { PDF_MISSING, buildTradePdfModel, type TradePdfField, type TradePdfModel } from "./tradePdfModel";
import { buildPeriodAnalysis, type AnalysisBlock, type AnalysisTable, type PeriodAnalysis } from "./tradePdfAnalysis";
import type { BulkPdfSummary } from "./bulkPdf";

export type PdfImage = { dataUrl: string; format: string };

export type PdfTextOptions = { align?: "left" | "center" | "right" };

/** The slice of jsPDF this writer needs; a real jsPDF document satisfies it. */
export type PdfDoc = {
  addPage(): unknown;
  setPage(page: number): unknown;
  getNumberOfPages(): number;
  setFillColor(red: number, green: number, blue: number): unknown;
  setTextColor(red: number, green: number, blue: number): unknown;
  setFontSize(size: number): unknown;
  setFont?(name: string, style?: string): unknown;
  rect(x: number, y: number, width: number, height: number, style?: string): unknown;
  roundedRect?(x: number, y: number, width: number, height: number, radiusX: number, radiusY: number, style?: string): unknown;
  text(text: string | string[], x: number, y: number, options?: PdfTextOptions): unknown;
  splitTextToSize(text: string, maxWidth: number): string[];
  addImage(dataUrl: string, format: string, x: number, y: number, width: number, height: number): unknown;
  getImageProperties(dataUrl: string): { width: number; height: number };
};

/** A4 landscape, in millimetres. */
export const PDF_PAGE = { width: 297, height: 210, margin: 12, columns: 3, footerBaseline: 206 } as const;

export const PDF_COLORS = {
  bg: [16, 20, 26],
  gold: [233, 182, 75],
  text: [235, 240, 245],
  muted: [146, 159, 171],
  dim: [110, 122, 134],
  green: [110, 205, 150],
  red: [226, 116, 110],
  line: [44, 55, 68],
} as const;

export const SCREENSHOT_EMBED_FAILURE = "Screenshot evidence could not be embedded during export.";

type Rgb = readonly [number, number, number];

/* ------------------------------------------------------------------ *
 * Typography tiers
 * ------------------------------------------------------------------ */

type Metrics = {
  body: number;
  line: number;
  label: number;
  labelLine: number;
  colGap: number;
  rowGap: number;
  section: number;
  sectionAdvance: number;
  title: number;
};

/** Readable first, compact second: the first tier that fits the page wins. */
const TRADE_METRICS: Metrics[] = [
  { body: 8, line: 3.8, label: 6.8, labelLine: 3.2, colGap: 6, rowGap: 1.5, section: 8.6, sectionAdvance: 5, title: 15 },
  { body: 7.6, line: 3.5, label: 6.5, labelLine: 2.9, colGap: 5.5, rowGap: 1.2, section: 8, sectionAdvance: 4.6, title: 14 },
  { body: 7.2, line: 3.2, label: 6.2, labelLine: 2.7, colGap: 5, rowGap: 1, section: 7.6, sectionAdvance: 4.3, title: 13 },
  { body: 7, line: 3.1, label: 6, labelLine: 2.6, colGap: 4.5, rowGap: 0.9, section: 7.4, sectionAdvance: 4.1, title: 13 },
];

const ANALYSIS_METRICS: Metrics = { body: 7.4, line: 3.2, label: 6.5, labelLine: 2.7, colGap: 6, rowGap: 0.9, section: 8.4, sectionAdvance: 4.7, title: 15 };
const TABLE_FONT = { title: 7.6, header: 6.2, body: 7, line: 3.4, padding: 0.7 };
/** Metrics per row in the analysis grid: four columns allow labelled inline rows. */
const METRIC_COLUMNS = 4;

const HEADER_HEIGHT = 17;
const SCREENSHOT_CAPTION = 6;
/** Space the at-a-glance identity band of a trade data page occupies. */
const TRADE_PAGE_BAND = 13.6;

/* ------------------------------------------------------------------ *
 * Context
 * ------------------------------------------------------------------ */

type Ctx = {
  doc: PdfDoc;
  /** The first page already exists in jsPDF, so it is painted rather than added. */
  started: boolean;
  y: number;
  bodyTop: number;
  bottom: number;
  contentWidth: number;
  metrics: Metrics;
  header: { eyebrow: string; title: string; continued: string };
  titleSize: number;
};

function setFill(doc: PdfDoc, color: Rgb) { doc.setFillColor(color[0], color[1], color[2]); }
function setText(doc: PdfDoc, color: Rgb) { doc.setTextColor(color[0], color[1], color[2]); }
function contextWidth() { return PDF_PAGE.width - PDF_PAGE.margin * 2; }
function contentBottom() { return PDF_PAGE.height - PDF_PAGE.margin - 4; }

function paintBackground(doc: PdfDoc) {
  setFill(doc, PDF_COLORS.bg);
  doc.rect(0, 0, PDF_PAGE.width, PDF_PAGE.height, "F");
}

/** Draws the page header band and returns the y the body may start at. */
function drawHeader(ctx: Ctx, title: string) {
  const doc = ctx.doc;
  const margin = PDF_PAGE.margin;
  setText(doc, PDF_COLORS.gold);
  doc.setFontSize(6.6);
  doc.text(ctx.header.eyebrow, margin, margin + 3.2);
  if (doc.setFont) doc.setFont("helvetica", "bold");
  setText(doc, PDF_COLORS.text);
  doc.setFontSize(ctx.titleSize);
  doc.text(doc.splitTextToSize(title, contextWidth())[0] ?? "", margin, margin + 9.4);
  if (doc.setFont) doc.setFont("helvetica", "normal");
  setFill(doc, PDF_COLORS.gold);
  doc.rect(margin, margin + 11.2, 30, 0.6, "F");
  return HEADER_HEIGHT;
}

function startPage(ctx: Ctx, options: { eyebrow: string; title: string; continued: string; titleSize?: number; metrics?: Metrics }) {
  if (ctx.started) ctx.doc.addPage();
  else ctx.started = true;
  ctx.header = { eyebrow: options.eyebrow, title: options.title, continued: options.continued };
  ctx.titleSize = options.titleSize ?? 15;
  ctx.metrics = options.metrics ?? TRADE_METRICS[1];
  paintBackground(ctx.doc);
  ctx.bodyTop = PDF_PAGE.margin + drawHeader(ctx, options.title);
  ctx.bottom = contentBottom();
  ctx.contentWidth = contextWidth();
  ctx.y = ctx.bodyTop;
}

/** Adds a continuation page that repeats the current report context. */
function nextPage(ctx: Ctx, continued = true) {
  startPage(ctx, {
    eyebrow: ctx.header.eyebrow,
    title: continued ? ctx.header.continued : ctx.header.title,
    continued: ctx.header.continued,
    titleSize: Math.min(ctx.titleSize, 14),
    metrics: ctx.metrics,
  });
}

function ensureSpace(ctx: Ctx, needed: number) {
  if (ctx.y + needed > ctx.bottom) nextPage(ctx);
}

/* ------------------------------------------------------------------ *
 * Small text utilities
 * ------------------------------------------------------------------ */

/**
 * Turns a value made of many short lines (a checklist or a tag list) into one
 * flowing line so the compact table keeps every item without spending a page on
 * it. Longer prose lines are left alone. No character is removed either way.
 */
export function compactListValue(value: string): string {
  const lines = value.split("\n").map(line => line.trim()).filter(Boolean);
  if (lines.length >= 3 && lines.every(line => line.length <= 44)) return lines.join(" · ");
  return value;
}

function wrapText(doc: PdfDoc, value: string, maxWidth: number): string[] {
  const paragraphs = value.split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.trim() === "") { lines.push(""); continue; }
    const wrapped = doc.splitTextToSize(paragraph, maxWidth) as string[];
    if (wrapped.length) lines.push(...wrapped);
  }
  return lines.length ? lines : [PDF_MISSING];
}

/** Writes wrapped text starting at `x`, returning the y it finished at. */
function writeWrapped(ctx: Ctx, value: string, options: { x?: number; maxWidth?: number; lineHeight?: number; color?: Rgb; fontSize?: number }) {
  const x = options.x ?? PDF_PAGE.margin;
  const lineHeight = options.lineHeight ?? ctx.metrics.line;
  const maxWidth = options.maxWidth ?? ctx.contentWidth;
  ctx.doc.setFontSize(options.fontSize ?? ctx.metrics.body);
  setText(ctx.doc, options.color ?? PDF_COLORS.text);
  for (const line of wrapText(ctx.doc, value, maxWidth)) {
    ensureSpace(ctx, lineHeight);
    ctx.doc.text(line, x, ctx.y);
    ctx.y += lineHeight;
  }
}

function sectionHeading(ctx: Ctx, title: string) {
  const metrics = ctx.metrics;
  ensureSpace(ctx, metrics.sectionAdvance);
  setText(ctx.doc, PDF_COLORS.gold);
  ctx.doc.setFontSize(metrics.section);
  ctx.doc.text(title.toUpperCase(), PDF_PAGE.margin, ctx.y);
  ctx.y += metrics.sectionAdvance - 2.4;
  setFill(ctx.doc, PDF_COLORS.line);
  ctx.doc.rect(PDF_PAGE.margin, ctx.y, ctx.contentWidth, 0.35, "F");
  ctx.y += 2.4;
}

const MONEY_LABELS = ["P&L", "Risk", "Reward", "R:R", "Actual R", "Balance", "MFE", "MAE", "Expectancy", "Gross"];

function valueColor(label: string, value: string): Rgb {
  if (!MONEY_LABELS.some(token => label.includes(token))) return PDF_COLORS.text;
  if (value === PDF_MISSING) return PDF_COLORS.muted;
  if (value.trim().startsWith("-")) return PDF_COLORS.red;
  if (label.includes("R:R")) return PDF_COLORS.text;
  return PDF_COLORS.green;
}

/* ------------------------------------------------------------------ *
 * Compact trade table layout
 * ------------------------------------------------------------------ */

type Cell = {
  label: string;
  value: string;
  span: number;
  lines: string[];
  labelLines: string[];
  stacked: boolean;
  color: Rgb;
};

type Row = { cells: Cell[]; height: number };

type LaidBlock =
  | { kind: "section"; title: string; height: number }
  | { kind: "rows"; rows: Row[]; height: number };

function columnWidth(span: number) {
  const gap = 6;
  const single = (contextWidth() - gap * (PDF_PAGE.columns - 1)) / PDF_PAGE.columns;
  return span >= PDF_PAGE.columns ? contextWidth() : single * span + gap * (span - 1);
}

/**
 * Lays out one field as a table cell. A value that does not fit a single column
 * (or is flagged long by the model) takes the full page width, so nothing has to
 * be truncated to keep the table three columns wide.
 */
function buildCell(doc: PdfDoc, field: TradePdfField, metrics: Metrics, options: { stacked?: boolean; span?: number } = {}): Cell {
  const value = compactListValue(field.value);
  const single = columnWidth(1);
  const singleValue = single - single * 0.42 - 3;
  const wide = field.wide || doc.splitTextToSize(value, singleValue).length > 2;
  const spanForced = options.span ?? (options.stacked ? 1 : wide ? PDF_PAGE.columns : 1);
  const width = columnWidth(spanForced);
  const labelWidth = options.stacked ? width : width * 0.42;
  doc.setFontSize(metrics.label);
  const labelLines = doc.splitTextToSize(field.label.toUpperCase(), Math.max(8, labelWidth - 1)) as string[];
  const canStack = Boolean(options.stacked) || labelLines.length > 1;
  doc.setFontSize(metrics.body);
  const valueWidth = canStack ? width : width - labelWidth - 2;
  const lines = doc.splitTextToSize(value, Math.max(8, valueWidth)) as string[];
  return {
    label: field.label.toUpperCase(),
    value,
    span: canStack && !options.stacked ? PDF_PAGE.columns : spanForced,
    lines: lines.length ? lines : [PDF_MISSING],
    labelLines: labelLines.length ? labelLines : [field.label.toUpperCase()],
    stacked: canStack,
    color: valueColor(field.label, value),
  };
}

function cellHeight(cell: Cell, metrics: Metrics) {
  const labelHeight = cell.stacked ? cell.labelLines.length * metrics.labelLine : 0;
  return labelHeight + cell.lines.length * metrics.line + metrics.rowGap;
}

/** Packs cells into full rows of the 3-column grid; a wide cell always ends its row. */
function packRows(cells: Cell[], metrics: Metrics): Row[] {
  const rows: Row[] = [];
  let current: Cell[] = [];
  let used = 0;
  const flush = () => {
    if (!current.length) return;
    rows.push({ cells: current, height: Math.max(...current.map(cell => cellHeight(cell, metrics))) });
    current = [];
    used = 0;
  };
  for (const cell of cells) {
    const span = Math.min(cell.span, PDF_PAGE.columns);
    if (span >= PDF_PAGE.columns) { flush(); rows.push({ cells: [cell], height: cellHeight(cell, metrics) }); continue; }
    if (used + span > PDF_PAGE.columns) flush();
    current.push(cell);
    used += span;
  }
  flush();
  return rows;
}

/** Builds the whole trade data page for one metrics tier. */
function layoutTradePage(doc: PdfDoc, model: TradePdfModel, metrics: Metrics): LaidBlock[] {
  const blocks: LaidBlock[] = [];
  const pushFields = (fields: TradePdfField[]) => {
    const rows = packRows(fields.map(field => buildCell(doc, field, metrics)), metrics);

    blocks.push({ kind: "rows", rows, height: rows.reduce((sum, row) => sum + row.height, 0) });
  };
  for (const section of model.sections) {
    blocks.push({ kind: "section", title: section.title, height: metrics.sectionAdvance });
    pushFields(section.fields);
  }
  if (model.additionalFields.length) {
    blocks.push({ kind: "section", title: "Additional recorded fields", height: metrics.sectionAdvance });
    pushFields(model.additionalFields);
  }
  // Psychology and the journal are laid out as stacked blocks: a three-column row
  // for before/during/after, then the notes across the full width.
  blocks.push({ kind: "section", title: "Psychology", height: metrics.sectionAdvance });
  const psychology = [
    { label: "Before trade", value: model.psychology.before },
    { label: "During trade", value: model.psychology.during },
    { label: "After trade", value: model.psychology.after },
  ].map(entry => buildCell(doc, { label: entry.label, value: entry.value.trim() === "" ? PDF_MISSING : entry.value }, metrics, { stacked: true, span: 1 }));
  blocks.push({ kind: "rows", rows: [{ cells: psychology, height: Math.max(...psychology.map(cell => cellHeight(cell, metrics))) }], height: Math.max(...psychology.map(cell => cellHeight(cell, metrics))) });

  blocks.push({ kind: "section", title: "Journal notes", height: metrics.sectionAdvance });
  const notes = buildCell(doc, { label: "Journal notes", value: model.journalNotes.trim() === "" ? PDF_MISSING : model.journalNotes }, metrics, { stacked: true, span: PDF_PAGE.columns });
  blocks.push({ kind: "rows", rows: [{ cells: [notes], height: cellHeight(notes, metrics) }], height: cellHeight(notes, metrics) });
  return blocks;
}

function renderRow(ctx: Ctx, row: Row) {
  const metrics = ctx.metrics;
  const doc = ctx.doc;
  const gap = metrics.colGap;
  ensureSpace(ctx, row.height);
  let x = PDF_PAGE.margin;
  for (const cell of row.cells) {
    const width = columnWidth(cell.span);
    if (cell.stacked) {
      doc.setFontSize(metrics.label);
      setText(doc, PDF_COLORS.muted);
      cell.labelLines.forEach((line, index) => doc.text(line, x, ctx.y + index * metrics.labelLine));
      const valueTop = ctx.y + cell.labelLines.length * metrics.labelLine;
      doc.setFontSize(metrics.body);
      setText(doc, cell.color);
      cell.lines.forEach((line, index) => doc.text(line, x, valueTop + index * metrics.line));
    } else {
      doc.setFontSize(metrics.label);
      setText(doc, PDF_COLORS.muted);
      doc.text(cell.labelLines[0] ?? cell.label, x, ctx.y);
      const valueX = x + width * 0.42;
      doc.setFontSize(metrics.body);
      setText(doc, cell.color);
      cell.lines.forEach((line, index) => doc.text(line, valueX, ctx.y + index * metrics.line));
    }
    x += width + gap;
  }
  ctx.y += row.height;
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

/** Browser-only WEBP → PNG upgrade; returns null when canvas is unavailable. */
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

/**
 * One fetch per screenshot per export. A URL that fails is remembered as well,
 * so a broken screenshot is not retried for every page that mentions it.
 */
export function createPdfImageCache(fetchImage: (url: string) => Promise<PdfImage> = fetchPdfImage) {
  const cache = new Map<string, Promise<PdfImage>>();
  return (url: string) => {
    const hit = cache.get(url);
    if (hit) return hit;
    const pending = fetchImage(url);
    pending.catch(() => undefined);
    cache.set(url, pending);
    return pending;
  };
}

/** Fits an image inside a box with `contain`, preserving its aspect ratio. */
export function fitInside(boxWidth: number, boxHeight: number, width: number, height: number) {
  const scale = Math.min(boxWidth / width, boxHeight / height);
  return { width: width * scale, height: height * scale };
}

type ScreenshotPageOptions = { model: TradePdfModel; position: string; fetchImage: (url: string) => Promise<PdfImage> };

function identityLines(model: TradePdfModel) {
  const ticket = model.sections.flatMap(section => section.fields).find(field => field.label === "MT5 ticket")?.value ?? PDF_MISSING;
  return `Trade ID ${model.idLabel} · ${model.tradeDate} · ${model.symbol} · ${model.direction} · ${model.result} · ${model.pnl} · MT5 ${ticket}`;
}

async function renderScreenshotPage(ctx: Ctx, options: ScreenshotPageOptions) {
  const { model, position, fetchImage } = options;
  startPage(ctx, {
    eyebrow: "GOLD JOURNAL · SCREENSHOT EVIDENCE",
    title: `${position} · ${model.symbol} · ${model.direction} · ${model.result} · ${model.pnl}`,
    continued: `${position} — screenshot (continued)`,
    titleSize: 14,
    metrics: ANALYSIS_METRICS,
  });
  ctx.doc.setFontSize(7.2);
  writeWrapped(ctx, identityLines(model), { color: PDF_COLORS.muted, lineHeight: 3.4 });
  ctx.y += 2;
  const evidence = model.evidence;
  const filename = evidence.filename ?? "not recorded";
  const linkStatus = evidence.url ? "available at export time" : "unavailable at export time";

  if (!evidence.url) {
    sectionHeading(ctx, "No screenshot available");
    ctx.doc.setFontSize(8);
    writeWrapped(ctx, evidence.hasScreenshot
      ? `A screenshot is recorded for this trade but no export link was available at export time. ${SCREENSHOT_EMBED_FAILURE}`
      : "No screenshot was saved with this trade.", { color: evidence.hasScreenshot ? PDF_COLORS.red : PDF_COLORS.muted, lineHeight: 3.6 });
    writeWrapped(ctx, `File name: ${filename} · Export link: ${linkStatus}`, { color: PDF_COLORS.dim, lineHeight: 3.6 });
    return;
  }

  try {
    // Fetched and measured first, so the heading, the metadata, and the image
    // always land together and the image can never overflow the page.
    const image = await fetchImage(evidence.url);
    const properties = ctx.doc.getImageProperties(image.dataUrl);
    const width = Number(properties?.width);
    const height = Number(properties?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("Screenshot dimensions could not be read");
    const boxHeight = ctx.bottom - ctx.y - SCREENSHOT_CAPTION;
    if (boxHeight <= 20) throw new Error("No page space is available for the screenshot");
    // Contain, never stretch or crop. Small images are enlarged modestly (up to
    // 1.5x their natural print size) instead of being blown up to full width.
    const naturalWidth = width / 96 * 25.4;
    const naturalHeight = height / 96 * 25.4;
    const available = fitInside(Math.min(ctx.contentWidth, naturalWidth * 1.5), Math.min(boxHeight, naturalHeight * 1.5), width, height);
    const x = PDF_PAGE.margin + (ctx.contentWidth - available.width) / 2;
    ctx.doc.addImage(image.dataUrl, image.format, x, ctx.y, available.width, available.height);
    ctx.y += available.height + 2.4;
    ctx.doc.setFontSize(7);
    writeWrapped(ctx, `Embedded at ${Math.round(available.width)} × ${Math.round(available.height)} mm (${image.format}, ${width} × ${height} px) · File name: ${filename}`, { color: PDF_COLORS.dim, lineHeight: 3.4 });
  } catch (error: any) {
    // A single unreadable image never aborts the report: the trade's data page is
    // already written and every remaining trade is rendered normally.
    sectionHeading(ctx, "Screenshot evidence");
    ctx.doc.setFontSize(8);
    writeWrapped(ctx, `${SCREENSHOT_EMBED_FAILURE} Screenshot unavailable at export time.`, { color: PDF_COLORS.red, lineHeight: 3.6 });
    writeWrapped(ctx, `File name: ${filename} · Export link: ${linkStatus} · ${error?.message ?? "unavailable"}`, { color: PDF_COLORS.dim, lineHeight: 3.6 });
    writeWrapped(ctx, "Every other field of this trade is unaffected and the report continues with the next trade.", { color: PDF_COLORS.muted, lineHeight: 3.6 });
  }
}

/* ------------------------------------------------------------------ *
 * Trade pages
 * ------------------------------------------------------------------ */

/**
 * Measures the trade data page against every typography tier.
 *
 * The first tier that fits one page wins, so an ordinary trade is always exactly
 * one data page; the smallest tier is only used, and content only continues onto
 * another page, when the recorded data genuinely cannot be laid out otherwise.
 */
export function measureTradeDataPage(doc: PdfDoc, model: TradePdfModel) {
  const available = contentBottom() - (PDF_PAGE.margin + HEADER_HEIGHT) - TRADE_PAGE_BAND;
  const measured = TRADE_METRICS.map(tier => ({ tier, height: layoutTradePage(doc, model, tier).reduce((sum, block) => sum + block.height, 0) }));
  const chosen = measured.find(entry => entry.height <= available) ?? measured[measured.length - 1];
  return { available, height: chosen.height, tier: chosen.tier, fits: chosen.height <= available, measurements: measured.map(entry => entry.height) };
}

function renderTradeDataPage(ctx: Ctx, model: TradePdfModel, index: number, total: number) {
  const position = `Trade ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
  const meta = `${model.tradeDate} · ${model.symbol} · ${model.direction} · ${model.result} · ${model.pnl} · Session ${model.session}`;
  const measurement = measureTradeDataPage(ctx.doc, model);
  const metrics = measurement.tier;
  const blocks = layoutTradePage(ctx.doc, model, metrics);

  startPage(ctx, {
    eyebrow: "GOLD JOURNAL · TRADE CARD",
    title: `${position} · ${model.symbol} · ${model.direction}`,
    continued: `${position} — complete trade data (continued)`,
    titleSize: metrics.title,
    metrics,
  });
  // At-a-glance band: the figures the trade is identified by, on one line.
  const doc = ctx.doc;
  doc.setFontSize(10.5);
  setText(doc, PDF_COLORS.gold);
  doc.text(position, PDF_PAGE.margin, ctx.y + 3);
  doc.setFontSize(11.5);
  setText(doc, model.pnlValue < 0 ? PDF_COLORS.red : PDF_COLORS.green);
  doc.text(model.pnl, PDF_PAGE.margin + ctx.contentWidth, ctx.y + 3, { align: "right" });
  ctx.y += 5.6;
  doc.setFontSize(7.6);
  writeWrapped(ctx, compactListValue(meta), { color: PDF_COLORS.muted, lineHeight: 3.6 });
  ctx.y += 1.6;
  setFill(doc, PDF_COLORS.line);
  doc.rect(PDF_PAGE.margin, ctx.y, ctx.contentWidth, 0.3, "F");
  ctx.y += 2.6;

  for (const block of blocks) {
    if (block.kind === "section") sectionHeading(ctx, block.title);
    else for (const row of block.rows) renderRow(ctx, row);
  }
}

/* ------------------------------------------------------------------ *
 * Analysis pages
 * ------------------------------------------------------------------ */

/**
 * The analysis metric grid. A metric whose label and value both fit on one line is
 * written as a single labelled row (the compact case); anything longer drops the
 * value onto its own lines. The row height always follows the tallest cell, so no
 * value can ever overlap the row below it.
 */
function metricGrid(ctx: Ctx, items: { label: string; value: string }[]) {
  const metrics = ctx.metrics;
  const doc = ctx.doc;
  const gap = metrics.colGap;
  const perRow = METRIC_COLUMNS;
  const width = (ctx.contentWidth - gap * (perRow - 1)) / perRow;
  // Uppercase labels are wide: giving them half the cell keeps almost every
  // metric on a single labelled row instead of dropping the value to its own line.
  const labelWidth = width * 0.5;
  for (let index = 0; index < items.length; index += perRow) {
    const slice = items.slice(index, index + perRow);
    doc.setFontSize(metrics.label);
    const cells = slice.map(item => {
      const label = item.label.toUpperCase();
      const inline = doc.splitTextToSize(label, labelWidth - 1).length === 1;
      doc.setFontSize(metrics.body);
      const valueLines = doc.splitTextToSize(item.value, Math.max(8, inline ? width - labelWidth - 2 : width)) as string[];
      return { item, label, inline, lines: valueLines.length ? valueLines : [PDF_MISSING] };
    });
    const height = Math.max(...cells.map(cell => (cell.inline ? 0 : metrics.labelLine) + cell.lines.length * metrics.line)) + metrics.rowGap;
    ensureSpace(ctx, height);
    cells.forEach((cell, cellIndex) => {
      const x = PDF_PAGE.margin + cellIndex * (width + gap);
      doc.setFontSize(metrics.label);
      setText(doc, PDF_COLORS.muted);
      doc.text(cell.label, x, ctx.y);
      doc.setFontSize(metrics.body);
      setText(doc, valueColor(cell.item.label, cell.item.value));
      const top = ctx.y + (cell.inline ? 0 : metrics.labelLine);
      cell.lines.forEach((line, lineIndex) => doc.text(line, cell.inline ? x + labelWidth : x, top + lineIndex * metrics.line));
    });
    ctx.y += height;
  }
}

function tableColumnWidths(table: AnalysisTable, width: number) {
  const total = table.columns.reduce((sum, column) => sum + column.flex, 0) || 1;
  return table.columns.map(column => (width * column.flex) / total);
}

/** The vertical space a table's title, header rule, and first row need. */
const TABLE_HEADER_BLOCK = 2.2 + 1 + TABLE_FONT.line;

/**
 * The exact height `renderTable` will consume, so a pair of tables is only moved
 * to another page when it genuinely does not fit, and side-by-side tables can be
 * aligned without either one overflowing the page.
 */
function measureTable(ctx: Ctx, table: AnalysisTable, width: number) {
  const doc = ctx.doc;
  const perCell = tableColumnWidths(table, width);
  doc.setFontSize(TABLE_FONT.body);
  const rows = table.rows.map(row => {
    const lines = Math.max(1, ...row.map((value, index) => doc.splitTextToSize(String(value), Math.max(4, perCell[index] - 2)).length));
    return lines * TABLE_FONT.line + TABLE_FONT.padding;
  });
  const empty = table.rows.length ? 0 : TABLE_FONT.line * 2;
  return TABLE_HEADER_BLOCK + rows.reduce((sum, height) => sum + height, 0) + empty;
}

/** Draws a table, repeating the title and the header row after a page break. */
function renderTable(ctx: Ctx, table: AnalysisTable, width: number, x: number = PDF_PAGE.margin) {
  const doc = ctx.doc;
  const perCell = tableColumnWidths(table, width);
  const drawHeader = () => {
    doc.setFontSize(TABLE_FONT.title);
    setText(doc, PDF_COLORS.gold);
    doc.text(table.title.toUpperCase(), x, ctx.y);
    ctx.y += 2.2;
    doc.setFontSize(TABLE_FONT.header);
    setText(doc, PDF_COLORS.muted);
    let cursor = x;
    table.columns.forEach((column, index) => {
      doc.text(column.label.toUpperCase(), column.align === "right" ? cursor + perCell[index] : cursor, ctx.y, column.align === "right" ? { align: "right" } : undefined);
      cursor += perCell[index];
    });
    ctx.y += 1;
    setFill(doc, PDF_COLORS.line);
    doc.rect(x, ctx.y, width, 0.3, "F");
    ctx.y += TABLE_FONT.line;
  };
  ensureSpace(ctx, TABLE_FONT.title + 2 + TABLE_FONT.line * 2);
  drawHeader();
  if (!table.rows.length) {
    doc.setFontSize(TABLE_FONT.body);
    setText(doc, PDF_COLORS.dim);
    doc.text(table.empty, x, ctx.y);
    ctx.y += TABLE_FONT.line * 2;
    return;
  }
  for (const row of table.rows) {
    doc.setFontSize(TABLE_FONT.body);
    const wrapped = row.map((value, index) => {
      const lines = doc.splitTextToSize(String(value), Math.max(4, perCell[index] - 2)) as string[];
      return lines.length ? lines : [PDF_MISSING];
    });
    const height = Math.max(...wrapped.map(lines => lines.length)) * TABLE_FONT.line + TABLE_FONT.padding;
    if (ctx.y + height > ctx.bottom) {
      nextPage(ctx);
      drawHeader();
      doc.setFontSize(TABLE_FONT.body);
    }
    let cursor = x;
    wrapped.forEach((lines, index) => {
      const column = table.columns[index];
      setText(doc, column.align === "right" ? valueColor(column.label, lines[0]) : PDF_COLORS.text);
      lines.forEach((line, lineIndex) => {
        const lineY = ctx.y + lineIndex * TABLE_FONT.line;
        doc.text(line, column.align === "right" ? cursor + perCell[index] : cursor, lineY, column.align === "right" ? { align: "right" } : undefined);
      });
      cursor += perCell[index];
    });
    ctx.y += height;
  }
  ctx.y += 2.4;
}

function renderAnalysisBlock(ctx: Ctx, block: AnalysisBlock) {
  if (block.kind === "heading") { sectionHeading(ctx, block.title); return; }
  if (block.kind === "metrics") { metricGrid(ctx, block.items); return; }
  if (block.kind === "table") { renderTable(ctx, block.table, ctx.contentWidth); return; }
  if (block.kind === "tableRow") {
    const gap = ctx.metrics.colGap;
    const half = (ctx.contentWidth - gap) / 2;
    const tallest = Math.max(0, ...block.tables.map(table => measureTable(ctx, table, half)));
    if (ctx.y + tallest > ctx.bottom) {
      // Side by side no longer fits on this page. Each table is re-measured at the
      // full width instead of moving both to a fresh page, so the space left on
      // this page is still used and no page is wasted on a single table.
      for (const table of block.tables) renderTable(ctx, table, ctx.contentWidth);
      return;
    }
    const startY = ctx.y;
    block.tables.forEach((table, index) => {
      ctx.y = startY;
      renderTable(ctx, table, half, PDF_PAGE.margin + index * (half + gap));
    });
    ctx.y = startY + tallest;
    return;
  }
  if (block.kind === "paragraph" && block.flow) {
    if (block.title) sectionHeading(ctx, block.title);
    writeWrapped(ctx, block.lines.join(" · "), { color: PDF_COLORS.text, lineHeight: 3.3, fontSize: ANALYSIS_METRICS.body });
    return;
  }
  if (block.title) sectionHeading(ctx, block.title);
  ctx.doc.setFontSize(ANALYSIS_METRICS.body);
  for (const line of block.lines) writeWrapped(ctx, `• ${line}`, { color: PDF_COLORS.text, lineHeight: 3.3, fontSize: ANALYSIS_METRICS.body });
}

function renderAnalysis(ctx: Ctx, options: TradeLogPdfOptions, analysis: PeriodAnalysis) {
  startPage(ctx, {
    eyebrow: "GOLD JOURNAL · PRIVATE PERFORMANCE REPORT",
    title: `Period analysis · ${options.accountName}`,
    continued: "Period analysis (continued)",
    titleSize: 15,
    metrics: ANALYSIS_METRICS,
  });
  ctx.doc.setFontSize(7.4);
  writeWrapped(ctx, `${options.mode === "ALL_TIME" ? "Whole trade log" : "Selected period"} · ${options.rangeLabel} · every figure below is calculated from the ${analysis.total} exported trade${analysis.total === 1 ? "" : "s"} in this report, using the same analysis engine as the Performance view.`, { color: PDF_COLORS.muted, lineHeight: 3.6 });
  ctx.y += 3;
  for (const block of analysis.blocks) renderAnalysisBlock(ctx, block);
}

/* ------------------------------------------------------------------ *
 * Summary + footer
 * ------------------------------------------------------------------ */

function renderEmptyReport(ctx: Ctx, options: TradeLogPdfOptions) {
  startPage(ctx, {
    eyebrow: "GOLD JOURNAL · PRIVATE PERFORMANCE REPORT",
    title: `No trades found for the selected period`,
    continued: "No trades found",
    titleSize: 16,
    metrics: ANALYSIS_METRICS,
  });
  ctx.doc.setFontSize(9);
  writeWrapped(ctx, `Account: ${options.accountName}`, { color: PDF_COLORS.text, lineHeight: 4.2, fontSize: 9 });
  writeWrapped(ctx, `Selected date range: ${options.rangeLabel}`, { color: PDF_COLORS.text, lineHeight: 4.2, fontSize: 9 });
  ctx.y += 2;
  writeWrapped(ctx, "No trade matched the selected account and date range, so there is nothing to export. Change the range, or add trades to this account, and run the export again.", { color: PDF_COLORS.muted, lineHeight: 4.2, fontSize: 8.4 });
}

function renderFooters(doc: PdfDoc, options: TradeLogPdfOptions, total: number) {
  const label = `Gold Journal · ${options.accountName} · ${options.rangeLabel}`;
  for (let page = 1; page <= total; page += 1) {
    doc.setPage(page);
    doc.setFontSize(6.6);
    setText(doc, PDF_COLORS.dim);
    doc.text(label, PDF_PAGE.margin, PDF_PAGE.footerBaseline);
    doc.text(`Page ${page} / ${total}`, PDF_PAGE.width - PDF_PAGE.margin, PDF_PAGE.footerBaseline, { align: "right" });
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export type TradeLogPdfTrade = { trade: Record<string, unknown>; runningBalance?: number | null };

export type TradeLogPdfOptions = {
  accountName: string;
  rangeLabel: string;
  mode: "ALL_TIME" | "RANGE";
  summary: BulkPdfSummary;
  trades: TradeLogPdfTrade[];
  fetchImage?: (url: string) => Promise<PdfImage>;
  /** Injected by tests; production builds it from the exported trades. */
  analysis?: PeriodAnalysis;
};

/**
 * Renders the whole report: two pages per trade (complete data table, then its
 * screenshot), the period analysis, and a footer on every page — all from the
 * same exported trade set, with one screenshot fetch per unique URL.
 */
export async function renderTradeLogPdf(doc: PdfDoc, options: TradeLogPdfOptions) {
  const ctx: Ctx = {
    doc,
    started: false,
    y: PDF_PAGE.margin,
    bodyTop: PDF_PAGE.margin,
    bottom: contentBottom(),
    contentWidth: contextWidth(),
    metrics: TRADE_METRICS[1],
    header: { eyebrow: "", title: "", continued: "" },
    titleSize: 15,
  };
  if (!options.trades.length) {
    renderEmptyReport(ctx, options);
    const total = doc.getNumberOfPages();
    renderFooters(doc, options, total);
    return { pages: total, trades: 0 };
  }
  const fetchImage = createPdfImageCache(options.fetchImage ?? fetchPdfImage);
  for (let index = 0; index < options.trades.length; index += 1) {
    const row = options.trades[index];
    const model = buildTradePdfModel(row.trade, { runningBalance: row.runningBalance ?? null });
    renderTradeDataPage(ctx, model, index, options.trades.length);
    await renderScreenshotPage(ctx, { model, position: `Trade ${String(index + 1).padStart(2, "0")} / ${String(options.trades.length).padStart(2, "0")}`, fetchImage });
  }
  const analysis = options.analysis ?? buildPeriodAnalysis(options.trades.map(row => row.trade), { accountName: options.accountName, rangeLabel: options.rangeLabel });
  renderAnalysis(ctx, options, analysis);
  const total = doc.getNumberOfPages();
  renderFooters(doc, options, total);
  return { pages: total, trades: options.trades.length, summary: options.summary, analysis };
}
