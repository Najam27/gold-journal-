/**
 * The PDF report renderer.
 *
 * Design contract (a fixed, deliberately constructed document):
 *   • A4 landscape with a neutral white page, dark text, one restrained accent,
 *     hairline rules, and a controlled positive/negative colour pair — the
 *     document has its own print palette, so neither the app theme (light or dark)
 *     nor a dark-mode class can change how it reads or prints;
 *   • two pages per trade: a complete trade-data page (header, KPI strip, then
 *     sections 1-8 laid out in two columns) and a screenshot evidence page;
 *   • four analysis pages after the trades — performance, process, psychology,
 *     review — each answering one question;
 *   • a footer on every page with the account, the period, and `Page X / Y`.
 *
 * It never decides what a trade contains: every value comes from
 * `buildTradePdfModel`, and the analysis pages come from `buildPeriodAnalysis`
 * (which is computed by `@shared/analysisEngine`). Long values are wrapped inside
 * their block, and a value that genuinely cannot fit continues onto a labelled
 * continuation page — nothing is truncated and no font is driven below ~7pt.
 *
 * A `PdfDoc` is passed in rather than a concrete jsPDF instance, so the layout,
 * pagination, and screenshot fitting rules are unit-testable in Node while the
 * application passes a real jsPDF document.
 */

import { PDF_MISSING, buildTradePdfModel, fieldTone, type TradePdfChecklistItem, type TradePdfField, type TradePdfModel, type TradePdfTone } from "./tradePdfModel";
import { buildPeriodAnalysis, type AnalysisBlock, type AnalysisPage, type AnalysisTable, type PeriodAnalysis } from "./tradePdfAnalysis";
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
  setDrawColor?(red: number, green: number, blue: number): unknown;
  setLineWidth?(width: number): unknown;
  setFontSize(size: number): unknown;
  setFont?(name: string, style?: string): unknown;
  rect(x: number, y: number, width: number, height: number, style?: string): unknown;
  roundedRect?(x: number, y: number, width: number, height: number, radiusX: number, radiusY: number, style?: string): unknown;
  line?(x1: number, y1: number, x2: number, y2: number): unknown;
  text(text: string | string[], x: number, y: number, options?: PdfTextOptions): unknown;
  splitTextToSize(text: string, maxWidth: number): string[];
  addImage(dataUrl: string, format: string, x: number, y: number, width: number, height: number): unknown;
  getImageProperties(dataUrl: string): { width: number; height: number };
};

/** A4 landscape, in millimetres. */
export const PDF_PAGE = { width: 297, height: 210, margin: 12, footerBaseline: 205 } as const;

/**
 * The document's own print palette: a neutral page, dark ink, one accent, and a
 * single positive/negative pair used consistently for every money and R figure.
 */
export const PDF_COLORS = {
  page: [255, 255, 255],
  ink: [26, 32, 40],
  inkSoft: [92, 102, 114],
  inkFaint: [138, 147, 158],
  accent: [156, 118, 34],
  accentSoft: [250, 246, 237],
  panel: [246, 247, 249],
  panelLine: [222, 227, 233],
  rule: [214, 220, 227],
  positive: [21, 122, 74],
  negative: [178, 48, 48],
  neutral: [92, 102, 114],
  warning: [170, 110, 16],
  accentAlt: [47, 92, 158],
} as const;

export const SCREENSHOT_EMBED_FAILURE = "Screenshot evidence could not be embedded during export.";

type Rgb = readonly [number, number, number];

const TONE_COLORS: Record<TradePdfTone, Rgb> = {
  neutral: PDF_COLORS.ink,
  positive: PDF_COLORS.positive,
  negative: PDF_COLORS.negative,
  signed: PDF_COLORS.ink,
  accent: PDF_COLORS.accent,
  warning: PDF_COLORS.warning,
};

function toneColor(tone: TradePdfTone | undefined, value?: string): Rgb {
  const resolved = tone === "signed" && value ? fieldTone({ tone, value }) : tone ?? "neutral";
  if (resolved === "signed") return PDF_COLORS.ink;
  return TONE_COLORS[resolved] ?? PDF_COLORS.ink;
}

/* ------------------------------------------------------------------ *
 * Typography
 * ------------------------------------------------------------------ */

type Metrics = {
  body: number;
  line: number;
  label: number;
  labelLine: number;
  gap: number;
  rowGap: number;
  section: number;
  sectionAdvance: number;
  title: number;
};

/**
 * Readable first, compact second: the first tier that fits the page wins.
 * No tier drops a value or a label below 7pt — labels, headings, and body text all
 * stay at or above the printable floor, and a trade that genuinely cannot be laid
 * out at 7pt continues onto a labelled page instead of shrinking further.
 */
const TRADE_METRICS: Metrics[] = [
  { body: 8, line: 3.7, label: 7.4, labelLine: 3, gap: 7, rowGap: 1.5, section: 8.4, sectionAdvance: 4.9, title: 17 },
  { body: 7.6, line: 3.5, label: 7.2, labelLine: 2.9, gap: 6, rowGap: 1.2, section: 8, sectionAdvance: 4.6, title: 16 },
  { body: 7.2, line: 3.3, label: 7.1, labelLine: 2.8, gap: 5, rowGap: 1, section: 7.6, sectionAdvance: 4.3, title: 15 },
  { body: 7, line: 3.1, label: 7, labelLine: 2.7, gap: 4.5, rowGap: 0.9, section: 7.4, sectionAdvance: 4.1, title: 15 },
];

const ANALYSIS_METRICS: Metrics = { body: 7.6, line: 3.4, label: 7.2, labelLine: 3, gap: 6, rowGap: 1.1, section: 8.4, sectionAdvance: 4.8, title: 16 };
const TABLE_FONT = { title: 8, header: 7, body: 7.2, line: 3.4, padding: 0.7 };
/**
 * The smallest type the report's content uses: eyebrows, KPI labels, field
 * labels, table headers, and body text all stay at or above this, so nothing a
 * trader has to read is shrunk to fit. (The footer credit line sits one notch
 * below, which is where a page credit belongs.)
 */
export const PDF_MIN_FONT = 7;
const METRIC_COLUMNS = 4;
const KPI_COLUMNS = 6;

const HEADER_HEIGHT = 18;
const SCREENSHOT_CAPTION = 5;
/** Height of the trade page's KPI strip, including its gaps. */
const KPI_STRIP_HEIGHT = 18.5;

/* ------------------------------------------------------------------ *
 * Context and primitives
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
  header: { eyebrow: string; title: string; continued: string; caption?: string };
  titleSize: number;
};

function setFill(doc: PdfDoc, color: Rgb) { doc.setFillColor(color[0], color[1], color[2]); }
function setText(doc: PdfDoc, color: Rgb) { doc.setTextColor(color[0], color[1], color[2]); }
function setDraw(doc: PdfDoc, color: Rgb) { doc.setDrawColor?.(color[0], color[1], color[2]); doc.setLineWidth?.(0.2); }
function contentWidth() { return PDF_PAGE.width - PDF_PAGE.margin * 2; }
function contentBottom() { return PDF_PAGE.height - PDF_PAGE.margin - 5; }

function paintPage(doc: PdfDoc) {
  setFill(doc, PDF_COLORS.page);
  doc.rect(0, 0, PDF_PAGE.width, PDF_PAGE.height, "F");
}

function hairline(ctx: Ctx, y: number, x: number, width: number, color: Rgb = PDF_COLORS.rule, height = 0.25) {
  setFill(ctx.doc, color);
  ctx.doc.rect(x, y, width, height, "F");
}

function panel(ctx: Ctx, x: number, y: number, width: number, height: number, fill: Rgb = PDF_COLORS.panel, border: Rgb = PDF_COLORS.panelLine) {
  setFill(ctx.doc, fill);
  if (ctx.doc.roundedRect) ctx.doc.roundedRect(x, y, width, height, 1.2, 1.2, "F");
  else ctx.doc.rect(x, y, width, height, "F");
  setDraw(ctx.doc, border);
  if (ctx.doc.roundedRect) ctx.doc.roundedRect(x, y, width, height, 1.2, 1.2, "S");
  else ctx.doc.rect(x, y, width, height, "S");
}

/** Draws the page header band and returns the y the body may start at. */
function drawHeader(ctx: Ctx, title: string) {
  const doc = ctx.doc;
  const margin = PDF_PAGE.margin;
  setText(doc, PDF_COLORS.inkFaint);
  doc.setFontSize(PDF_MIN_FONT);
  doc.text(ctx.header.eyebrow, margin, margin + 3.2);
  if (doc.setFont) doc.setFont("helvetica", "bold");
  setText(doc, PDF_COLORS.ink);
  doc.setFontSize(ctx.titleSize);
  doc.text(doc.splitTextToSize(title, contentWidth())[0] ?? "", margin, margin + 10.4);
  if (doc.setFont) doc.setFont("helvetica", "normal");
  if (ctx.header.caption) {
    setText(doc, PDF_COLORS.inkSoft);
    doc.setFontSize(7.2);
    doc.text(doc.splitTextToSize(ctx.header.caption, contentWidth())[0] ?? "", margin, margin + 14.6);
  }
  hairline(ctx, margin + 15.6, margin, contentWidth(), PDF_COLORS.accent, 0.6);
  return HEADER_HEIGHT;
}

function startPage(ctx: Ctx, options: { eyebrow: string; title: string; continued: string; caption?: string; titleSize?: number; metrics?: Metrics }) {
  if (ctx.started) ctx.doc.addPage();
  else ctx.started = true;
  ctx.header = { eyebrow: options.eyebrow, title: options.title, continued: options.continued, caption: options.caption };
  ctx.titleSize = options.titleSize ?? 16;
  ctx.metrics = options.metrics ?? TRADE_METRICS[1];
  paintPage(ctx.doc);
  ctx.bodyTop = PDF_PAGE.margin + drawHeader(ctx, options.title);
  ctx.bottom = contentBottom();
  ctx.contentWidth = contentWidth();
  ctx.y = ctx.bodyTop;
}

function nextPage(ctx: Ctx) {
  startPage(ctx, {
    eyebrow: ctx.header.eyebrow,
    title: ctx.header.continued,
    continued: ctx.header.continued,
    titleSize: Math.min(ctx.titleSize, 15),
    metrics: ctx.metrics,
  });
}

function ensureSpace(ctx: Ctx, needed: number) {
  if (ctx.y + needed > ctx.bottom) nextPage(ctx);
}

/* ------------------------------------------------------------------ *
 * Text utilities
 * ------------------------------------------------------------------ */

/**
 * Turns a value made of many short lines (a checklist or a tag list) into one
 * flowing line so a compact block keeps every item without spending a page on it.
 * Longer prose lines are left alone. No character is removed either way.
 */
export function compactListValue(value: string): string {
  const lines = value.split("\n").map(line => line.trim()).filter(Boolean);
  if (lines.length >= 3 && lines.every(line => line.length <= 44)) return lines.join(" · ");
  return value;
}

function wrapText(doc: PdfDoc, value: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    if (paragraph.trim() === "") { lines.push(""); continue; }
    const wrapped = doc.splitTextToSize(paragraph, maxWidth) as string[];
    if (wrapped.length) lines.push(...wrapped);
  }
  return lines.length ? lines : [PDF_MISSING];
}

/** Writes wrapped text from x, returning nothing but advancing ctx.y. */
function writeWrapped(ctx: Ctx, value: string, options: { x?: number; maxWidth?: number; lineHeight?: number; color?: Rgb; fontSize?: number } = {}) {
  const x = options.x ?? PDF_PAGE.margin;
  const lineHeight = options.lineHeight ?? ctx.metrics.line;
  const maxWidth = options.maxWidth ?? ctx.contentWidth;
  const fontSize = options.fontSize ?? ctx.metrics.body;
  const color = options.color ?? PDF_COLORS.ink;
  for (const line of wrapText(ctx.doc, value, maxWidth)) {
    // ensureSpace may start a page, and a page header sets its own type size, so
    // both the font and the colour are re-applied for every line.
    ensureSpace(ctx, lineHeight);
    ctx.doc.setFontSize(fontSize);
    setText(ctx.doc, color);
    ctx.doc.text(line, x, ctx.y);
    ctx.y += lineHeight;
  }
}

function sectionHeading(ctx: Ctx, title: string, x: number, width: number, options: { accent?: boolean } = {}) {
  const metrics = ctx.metrics;
  ensureSpace(ctx, metrics.sectionAdvance);
  ctx.doc.setFontSize(metrics.section);
  setText(ctx.doc, options.accent ? PDF_COLORS.accent : PDF_COLORS.ink);
  if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "bold");
  ctx.doc.text(title.toUpperCase(), x, ctx.y);
  if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "normal");
  hairline(ctx, ctx.y + 1.4, x, width, options.accent ? PDF_COLORS.accent : PDF_COLORS.rule, options.accent ? 0.45 : 0.25);
  ctx.y += metrics.sectionAdvance;
}

/* ------------------------------------------------------------------ *
 * Trade page blocks
 * ------------------------------------------------------------------ */

type Cell = { label: string; value: string; lines: string[]; labelLines: string[]; stacked: boolean; tone?: TradePdfTone };
type CompiledBlock =
  | { kind: "fields"; title: string; rows: Array<{ cells: Cell[]; height: number }>; height: number }
  | { kind: "checklist"; title: string; columns: TradePdfChecklistItem[][]; height: number }
  | { kind: "pairs"; title: string; rows: Array<{ label: string; value: string; tone?: TradePdfTone; height: number }>; height: number }
  | { kind: "badge"; title: string; label: string; summary: string; tone: TradePdfTone; height: number }
  | { kind: "note"; title: string; text: string; lines: string[]; height: number };

function columnWidth(ctx: Ctx) { return (ctx.contentWidth - ctx.metrics.gap) / 2; }

function buildCell(ctx: Ctx, field: TradePdfField, width: number): Cell {
  const metrics = ctx.metrics;
  const value = compactListValue(field.value);
  const labelWidth = width * 0.42;
  const valueWidth = width - labelWidth - 2;
  ctx.doc.setFontSize(metrics.label);
  const labelLines = ctx.doc.splitTextToSize(field.label.toUpperCase(), labelWidth - 0.5) as string[];
  const stacked = labelLines.length > 1 || field.wide === true;
  ctx.doc.setFontSize(metrics.body);
  const lines = ctx.doc.splitTextToSize(value, stacked ? width : valueWidth) as string[];
  return { label: field.label.toUpperCase(), value, lines: lines.length ? lines : [PDF_MISSING], labelLines: labelLines.length ? labelLines : [field.label.toUpperCase()], stacked, tone: field.tone };
}

function cellHeight(cell: Cell, metrics: Metrics) {
  const labelBlock = cell.stacked ? cell.labelLines.length * metrics.labelLine : 0;
  const valueLines = cell.stacked ? cell.lines.length * metrics.line : Math.max(cell.lines.length * metrics.line, metrics.line);
  return labelBlock + valueLines + metrics.rowGap;
}

/** Two fields per row inside a column, with long values taking the whole width. */
function compileFields(ctx: Ctx, title: string, fields: TradePdfField[], width: number): CompiledBlock {
  const metrics = ctx.metrics;
  const cells = fields.map(field => buildCell(ctx, field, width));
  const rows: Array<{ cells: Cell[]; height: number }> = [];
  let current: Cell[] = [];
  const flush = () => {
    if (!current.length) return;
    rows.push({ cells: current, height: Math.max(...current.map(cell => cellHeight(cell, metrics))) });
    current = [];
  };
  for (const cell of cells) {
    if (cell.stacked) { flush(); rows.push({ cells: [cell], height: cellHeight(cell, metrics) }); continue; }
    if (current.length >= 2) flush();
    current.push(cell);
  }
  flush();
  return { kind: "fields", title, rows, height: metrics.sectionAdvance + rows.reduce((sum, row) => sum + row.height, 0) };
}

/** The checklist as a two-column list of confirmed / not-confirmed items. */
function compileChecklist(ctx: Ctx, items: TradePdfChecklistItem[]): CompiledBlock {
  const metrics = ctx.metrics;
  const half = Math.ceil(items.length / 2);
  const columns = [items.slice(0, half), items.slice(half)];
  const rowHeight = metrics.line + 0.4;
  const height = metrics.sectionAdvance + Math.max(...columns.map(column => column.length)) * rowHeight + 1;
  return { kind: "checklist", title: "Pre-trade checklist", columns, height };
}

/**
 * Category / recorded-items rows (section 6). Two pairs share a row, so the six
 * categories stay compact while every recorded item is still shown in full.
 */
function compilePairs(ctx: Ctx, title: string, fields: TradePdfField[], width: number): CompiledBlock {
  const metrics = ctx.metrics;
  const pairWidth = (width - metrics.gap) / 2;
  const rows = fields.map(field => {
    const value = compactListValue(field.value);
    ctx.doc.setFontSize(metrics.body);
    const lines = ctx.doc.splitTextToSize(value, pairWidth * 0.6) as string[];
    return { label: field.label, value, tone: field.tone, height: Math.max(1, lines.length) * metrics.line + metrics.rowGap };
  });
  const rowHeights: number[] = [];
  for (let index = 0; index < rows.length; index += 2) rowHeights.push(Math.max(...rows.slice(index, index + 2).map(row => row.height)));
  return { kind: "pairs", title, rows, height: metrics.sectionAdvance + rowHeights.reduce((sum, height) => sum + height, 0) + 1 };
}

/** The process verdict, shown as its own panel so P&L never implies process quality. */
function compileBadge(ctx: Ctx, model: TradePdfModel): CompiledBlock {
  const metrics = ctx.metrics;
  ctx.doc.setFontSize(metrics.body);
  const summaryLines = (ctx.doc.splitTextToSize(model.classification.summary, columnWidth(ctx) - 8) as string[]).slice(0, 2);
  const height = metrics.sectionAdvance + 6.5 + summaryLines.length * metrics.line + 4;
  return { kind: "badge", title: "Process classification", label: model.classification.label, summary: model.classification.summary, tone: model.classification.tone, height };
}

function compileNote(ctx: Ctx, text: string, width: number): CompiledBlock {
  const metrics = ctx.metrics;
  ctx.doc.setFontSize(metrics.body);
  const value = text.trim() === "" ? PDF_MISSING : text;
  const lines = ctx.doc.splitTextToSize(value, width - 6) as string[];
  return { kind: "note", title: "Journal note", text: value, lines, height: metrics.sectionAdvance + Math.max(1, lines.length) * metrics.line + 6 };
}

function renderCompiledBlock(ctx: Ctx, block: CompiledBlock, x: number, width: number) {
  const metrics = ctx.metrics;
  const doc = ctx.doc;
  ensureSpace(ctx, block.height);
  const top = ctx.y;
  sectionHeading(ctx, block.title, x, width);

  if (block.kind === "fields") {
    for (const row of block.rows) {
      const cellWidth = row.cells.length === 1 ? width : (width - metrics.gap) / 2;
      let cursor = x;
      for (const cell of row.cells) {
        doc.setFontSize(metrics.label);
        setText(doc, PDF_COLORS.inkSoft);
        cell.labelLines.forEach((line, index) => doc.text(line, cursor, ctx.y + index * metrics.labelLine));
        const valueTop = cell.stacked ? ctx.y + cell.labelLines.length * metrics.labelLine : ctx.y;
        doc.setFontSize(metrics.body);
        setText(doc, toneColor(cell.tone, cell.value));
        const valueX = cell.stacked ? cursor : cursor + cellWidth * 0.42;
        cell.lines.forEach((line, index) => doc.text(line, valueX, valueTop + index * metrics.line));
        cursor += cellWidth + metrics.gap;
      }
      ctx.y += row.height;
    }
    return;
  }

  if (block.kind === "checklist") {
    const columnWidthValue = (width - metrics.gap) / 2;
    block.columns.forEach((items, columnIndex) => {
      items.forEach((item, index) => {
        const lineY = ctx.y + index * (metrics.line + 0.4);
        const mark = item.confirmed ? "✓" : "✗";
        doc.setFontSize(metrics.body);
        setText(doc, item.confirmed ? PDF_COLORS.positive : item.recorded ? PDF_COLORS.negative : PDF_COLORS.inkFaint);
        doc.text(mark, x + columnIndex * (columnWidthValue + metrics.gap), lineY);
        setText(doc, item.confirmed ? PDF_COLORS.ink : PDF_COLORS.inkSoft);
        doc.text(doc.splitTextToSize(item.label, columnWidthValue - 5)[0] ?? item.label, x + columnIndex * (columnWidthValue + metrics.gap) + 4, lineY);
      });
    });
    ctx.y += Math.max(...block.columns.map(column => column.length)) * (metrics.line + 0.4) + 1;
    return;
  }

  if (block.kind === "pairs") {
    const pairWidth = (width - metrics.gap) / 2;
    for (let index = 0; index < block.rows.length; index += 2) {
      const pair = block.rows.slice(index, index + 2);
      const rowHeight = Math.max(...pair.map(row => row.height));
      pair.forEach((row, cellIndex) => {
        const cellX = x + cellIndex * (pairWidth + metrics.gap);
        doc.setFontSize(metrics.label);
        setText(doc, PDF_COLORS.inkSoft);
        doc.text(row.label.toUpperCase(), cellX, ctx.y);
        doc.setFontSize(metrics.body);
        setText(doc, toneColor(row.tone, row.value));
        const wrapped = doc.splitTextToSize(compactListValue(row.value), pairWidth * 0.6) as string[];
        (wrapped.length ? wrapped : [PDF_MISSING]).forEach((line, lineIndex) => doc.text(line, cellX + pairWidth * 0.4, ctx.y + lineIndex * metrics.line));
      });
      ctx.y += rowHeight;
    }
    ctx.y += 1;
    return;
  }

  if (block.kind === "badge") {
    const tone = block.tone;
    const fill: Rgb = tone === "positive" ? [238, 247, 242] : tone === "negative" ? [252, 240, 240] : tone === "warning" ? [253, 247, 235] : tone === "accent" ? [242, 246, 253] : PDF_COLORS.panel;
    const summaryLines = (doc.splitTextToSize(block.summary, width - 8) as string[]).slice(0, 2);
    const boxHeight = 6.5 + summaryLines.length * metrics.line + 2.5;
    panel(ctx, x, ctx.y, width, boxHeight, fill, PDF_COLORS.panelLine);
    doc.setFontSize(10);
    if (doc.setFont) doc.setFont("helvetica", "bold");
    setText(doc, toneColor(tone));
    doc.text(block.label.toUpperCase(), x + 4, ctx.y + 6.4);
    if (doc.setFont) doc.setFont("helvetica", "normal");
    doc.setFontSize(metrics.body);
    setText(doc, PDF_COLORS.inkSoft);
    summaryLines.forEach((line, index) => doc.text(line, x + 4, ctx.y + 6.4 + 3.8 + index * metrics.line));
    ctx.y += boxHeight + 1.5;
    return;
  }

  // note: a bordered text box so the journal entry reads as one passage.
  const boxHeight = Math.max(1, block.lines.length) * metrics.line + 5;
  panel(ctx, x, ctx.y, width, boxHeight, [252, 252, 251], PDF_COLORS.rule);
  doc.setFontSize(metrics.body);
  setText(doc, PDF_COLORS.ink);
  block.lines.forEach((line, index) => doc.text(line, x + 3, ctx.y + 3.6 + index * metrics.line));
  ctx.y += boxHeight + 1.5;
}

/* ------------------------------------------------------------------ *
 * KPI strip
 * ------------------------------------------------------------------ */

function renderKpiStrip(ctx: Ctx, model: TradePdfModel) {
  const kpis = model.kpis;
  if (!kpis.length) return;
  const height = KPI_STRIP_HEIGHT;
  panel(ctx, PDF_PAGE.margin, ctx.y, ctx.contentWidth, height, PDF_COLORS.panel, PDF_COLORS.panelLine);
  const count = Math.max(1, kpis.length);
  const cellWidth = ctx.contentWidth / count;
  kpis.forEach((kpi, index) => {
    const x = PDF_PAGE.margin + index * cellWidth + 4;
    if (index > 0) hairline(ctx, ctx.y + 3, PDF_PAGE.margin + index * cellWidth, 0.2, PDF_COLORS.panelLine, height - 6);
    ctx.doc.setFontSize(PDF_MIN_FONT);
    setText(ctx.doc, PDF_COLORS.inkSoft);
    ctx.doc.text(kpi.label.toUpperCase(), x, ctx.y + 5.6);
    ctx.doc.setFontSize(11);
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "bold");
    setText(ctx.doc, toneColor(kpi.tone, kpi.value));
    ctx.doc.text(ctx.doc.splitTextToSize(kpi.value, cellWidth - 6)[0] ?? PDF_MISSING, x, ctx.y + 12.4);
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "normal");
  });
  ctx.doc.setFontSize(ctx.metrics.body);
  ctx.y += height + 4;
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

type ScreenshotContext = { model: TradePdfModel; position: string; fetchImage: (url: string) => Promise<PdfImage> };

/** The MT5 ticket as the card labels it, or the explicit missing marker. */
function ticketLabel(model: TradePdfModel): string {
  return model.sections.flatMap(section => section.fields).find(field => field.label === "MT5 ticket")?.value ?? PDF_MISSING;
}

/** The compact evidence bar under the image: format, size, and identifying fields. */
function renderEvidenceBar(ctx: Ctx, model: TradePdfModel, details: string) {
  const height = 12;
  panel(ctx, PDF_PAGE.margin, ctx.y, ctx.contentWidth, height, PDF_COLORS.panel, PDF_COLORS.panelLine);
  const ticket = ticketLabel(model);
  const cells = [
    ["Trade", `${model.idLabel} · ${model.tradeDate}`],
    ["MT5 ticket", ticket],
    ["Symbol", `${model.symbol} · ${model.session}`],
    ["Screenshot", model.evidence.filename ?? "not recorded"],
    ["Image", details],
  ];
  const cellWidth = ctx.contentWidth / cells.length;
  cells.forEach(([label, value], index) => {
    if (index > 0) hairline(ctx, ctx.y + 3, PDF_PAGE.margin + index * cellWidth, 0.2, PDF_COLORS.panelLine, height - 6);
    const x = PDF_PAGE.margin + index * cellWidth + 4;
    ctx.doc.setFontSize(PDF_MIN_FONT);
    setText(ctx.doc, PDF_COLORS.inkSoft);
    ctx.doc.text(label.toUpperCase(), x, ctx.y + 4.8);
    ctx.doc.setFontSize(7.6);
    setText(ctx.doc, PDF_COLORS.ink);
    ctx.doc.text(ctx.doc.splitTextToSize(String(value), cellWidth - 6)[0] ?? PDF_MISSING, x, ctx.y + 9.4);
  });
  ctx.y += height + 2;
}

async function renderScreenshotPage(ctx: Ctx, options: ScreenshotContext) {
  const { model, position, fetchImage } = options;
  startPage(ctx, {
    eyebrow: "GOLD JOURNAL · SCREENSHOT EVIDENCE",
    title: `${position} · ${model.direction} · ${model.result} · ${model.pnl}`,
    continued: `${position.toUpperCase()} — SCREENSHOT EVIDENCE (CONTINUED)`,
    caption: [model.tradeDate, model.symbol, model.session].join(" · ").toUpperCase(),
    titleSize: 15,
    metrics: ANALYSIS_METRICS,
  });

  const evidence = model.evidence;
  const filename = evidence.filename ?? "not recorded";

  if (!evidence.url) {
    const hasRecord = evidence.hasScreenshot;
    const boxHeight = 74;
    const centerX = PDF_PAGE.margin + ctx.contentWidth / 2;
    // Centred in the page's free area, so the evidence page reads as a deliberate
    // empty state instead of a heading with a gap under it.
    const top = ctx.y + Math.max(0, (ctx.bottom - ctx.y - boxHeight - SCREENSHOT_CAPTION - 12) / 2);
    panel(ctx, PDF_PAGE.margin, top, ctx.contentWidth, boxHeight, [251, 251, 250], PDF_COLORS.rule);
    ctx.doc.setFontSize(11);
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "bold");
    setText(ctx.doc, hasRecord ? PDF_COLORS.warning : PDF_COLORS.inkSoft);
    ctx.doc.text(hasRecord ? "SCREENSHOT UNAVAILABLE AT EXPORT TIME" : "NO SCREENSHOT AVAILABLE", centerX, top + 30, { align: "center" });
    ctx.doc.setFontSize(8);
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "normal");
    setText(ctx.doc, PDF_COLORS.inkSoft);
    const message = hasRecord
      ? "A screenshot is stored for this trade, but no export link was available when the report was built."
      : "No chart image is attached to this trade; the complete trade data is on the previous page.";
    (ctx.doc.splitTextToSize(message, ctx.contentWidth - 40) as string[]).forEach((line, index) => ctx.doc.text(line, centerX, top + 38 + index * 4, { align: "center" }));
    // The evidence stays identifiable even when there is no image to show.
    ctx.doc.setFontSize(PDF_MIN_FONT);
    setText(ctx.doc, PDF_COLORS.inkSoft);
    ctx.doc.text(`${position.toUpperCase()} · ${model.tradeDate} · ${model.symbol} · MT5 ${ticketLabel(model)}`, centerX, top + boxHeight - 9, { align: "center" });
    ctx.y = top + boxHeight + SCREENSHOT_CAPTION;
    renderEvidenceBar(ctx, model, `no image · ${hasRecord ? "link unavailable" : "not attached"}`);
    return;
  }

  try {
    // Fetched and measured first, so the image is fitted before anything is drawn
    // and the evidence bar always lands on the same page.
    const image = await fetchImage(evidence.url);
    const properties = ctx.doc.getImageProperties(image.dataUrl);
    const width = Number(properties?.width);
    const height = Number(properties?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("Screenshot dimensions could not be read");
    const boxHeight = ctx.bottom - ctx.y - SCREENSHOT_CAPTION - 14;
    if (boxHeight <= 20) throw new Error("No page space is available for the screenshot");
    // Contain, never stretch or crop. Small images are enlarged modestly (up to
    // 1.5x their natural print size) instead of being blown up to page width.
    const naturalWidth = width / 96 * 25.4;
    const naturalHeight = height / 96 * 25.4;
    const available = fitInside(Math.min(ctx.contentWidth, naturalWidth * 1.5), Math.min(boxHeight, naturalHeight * 1.5), width, height);
    const x = PDF_PAGE.margin + (ctx.contentWidth - available.width) / 2;
    setDraw(ctx.doc, PDF_COLORS.rule);
    ctx.doc.rect(x - 0.6, ctx.y - 0.6, available.width + 1.2, available.height + 1.2, "S");
    ctx.doc.addImage(image.dataUrl, image.format, x, ctx.y, available.width, available.height);
    ctx.y += available.height + 4;
    renderEvidenceBar(ctx, model, `${image.format} · ${width} × ${height} px · ${Math.round(available.width)} × ${Math.round(available.height)} mm`);
  } catch (error: any) {
    // A single unreadable image never aborts the report.
    panel(ctx, PDF_PAGE.margin, ctx.y, ctx.contentWidth, 42, [252, 244, 244], [232, 196, 196]);
    ctx.doc.setFontSize(10);
    setText(ctx.doc, PDF_COLORS.negative);
    ctx.doc.text("SCREENSHOT COULD NOT BE LOADED", PDF_PAGE.margin + 4, ctx.y + 9);
    ctx.doc.setFontSize(7.6);
    setText(ctx.doc, PDF_COLORS.inkSoft);
    (ctx.doc.splitTextToSize(`${SCREENSHOT_EMBED_FAILURE} The trade data is unaffected and the report continues with the next trade.`, ctx.contentWidth - 12) as string[]).forEach((line, index) => ctx.doc.text(line, PDF_PAGE.margin + 4, ctx.y + 16 + index * 3.6));
    ctx.y += 46;
    renderEvidenceBar(ctx, model, `load failed · ${error?.message ?? "unavailable"}`);
  }
}

/* ------------------------------------------------------------------ *
 * Trade page
 * ------------------------------------------------------------------ */

/**
 * The trade's identity, stated once: date, symbol, session, direction, result.
 * The P&L is not repeated here because the KPI strip is where it belongs, and the
 * field tables below carry every value again as the formal record.
 */
function tradeHeaderMeta(model: TradePdfModel) {
  return [model.tradeDate, model.symbol, model.session, model.direction, model.result].join(" · ").toUpperCase();
}

/**
 * Measures the trade data page for every typography tier.
 *
 * The first tier whose layout fits one page wins, so an ordinary trade is always
 * exactly one data page; the smallest tier is only used, and content only
 * continues onto another page, when the recorded data genuinely cannot be laid
 * out otherwise.
 */
export function measureTradeDataPage(doc: PdfDoc, model: TradePdfModel) {
  const available = contentBottom() - (PDF_PAGE.margin + HEADER_HEIGHT) - KPI_STRIP_HEIGHT - 4;
  const ctx: Ctx = {
    doc, started: false, y: 0, bodyTop: 0, bottom: contentBottom(), contentWidth: contentWidth(),
    metrics: TRADE_METRICS[1], header: { eyebrow: "", title: "", continued: "" }, titleSize: 16,
  };
  const measured = TRADE_METRICS.map(tier => {
    ctx.metrics = tier;
    ctx.y = 0;
    const blocks = tradePageBlocks(ctx, model, columnWidth(ctx));
    return { tier, height: tradePageHeight(ctx, blocks) };
  });
  const chosen = measured.find(entry => entry.height <= available) ?? measured[measured.length - 1];
  return { available, height: chosen.height, tier: chosen.tier, fits: chosen.height <= available, measurements: measured.map(entry => entry.height) };
}

type TradePageBlocks = {
  left: CompiledBlock[];
  right: CompiledBlock[];
  checklist: CompiledBlock;
  categories: CompiledBlock;
  psychologyHeight: number;
  psychologyLines: string[][];
  note: CompiledBlock;
  /**
   * Persisted properties the canonical model has no dedicated home for. Normally
   * empty — a future column lands here instead of being silently dropped.
   */
  extra: CompiledBlock | null;
};

function tradePageBlocks(ctx: Ctx, model: TradePdfModel, column: number): TradePageBlocks {
  const section = (id: string) => model.sections.find(entry => entry.id === id)?.fields ?? [];
  // Left column reads 1-2, right column reads 3-4, exactly the section order.
  const left: CompiledBlock[] = [
    compileFields(ctx, "1 · Trade overview", section("A"), column),
    compileFields(ctx, "2 · Strategy & execution", section("B"), column),
  ];
  const right: CompiledBlock[] = [
    compileFields(ctx, "3 · Risk & performance", section("C"), column),
    compileFields(ctx, "4 · Plan & discipline", section("D"), column),
    compileBadge(ctx, model),
  ];
  // Sections 5-8 sit below the columns. The checklist and the mistake categories
  // share one band, psychology takes three columns, and the journal note fills
  // whatever is left — continuing onto a labelled page only when it must.
  const checklist = compileChecklist(ctx, model.checklist);
  const categories = compilePairs(ctx, "6 · Process & mistakes", section("E"), ctx.contentWidth);
  const psychologyCells = [model.psychology.before, model.psychology.during, model.psychology.after];
  const cellWidth = (ctx.contentWidth - ctx.metrics.gap * 2) / 3;
  ctx.doc.setFontSize(ctx.metrics.body);
  const psychologyLines = psychologyCells.map(value => ctx.doc.splitTextToSize(value.trim() === "" ? PDF_MISSING : value, cellWidth - 6) as string[]);
  const psychologyHeight = ctx.metrics.sectionAdvance + Math.max(1, ...psychologyLines.map(lines => lines.length)) * ctx.metrics.line + 5;
  const note = compileNote(ctx, model.journalNotes, ctx.contentWidth);
  // Drift protection: any persisted field the sections above do not map still
  // reaches the document, so a new column can never vanish from an export.
  const extra = model.additionalFields.length ? compileFields(ctx, "9 · Additional recorded fields", model.additionalFields, ctx.contentWidth) : null;
  return { left, right, checklist, categories, psychologyHeight, psychologyLines, note, extra };
}

/** The full height of a trade data page: both columns, then every block below them. */
function tradePageHeight(ctx: Ctx, blocks: TradePageBlocks) {
  const columns = Math.max(
    blocks.left.reduce((sum, block) => sum + block.height, 0),
    blocks.right.reduce((sum, block) => sum + block.height, 0),
  );
  // The note needs at least its heading and two lines to be worth placing here.
  const noteMinimum = ctx.metrics.sectionAdvance + 2 * ctx.metrics.line + 6;
  return columns + 2 + Math.max(blocks.checklist.height, blocks.categories.height) + blocks.psychologyHeight + noteMinimum + (blocks.extra?.height ?? 0);
}

function renderTradeDataPage(ctx: Ctx, model: TradePdfModel, index: number, total: number) {
  const position = `Trade ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
  const measurement = measureTradeDataPage(ctx.doc, model);
  const metrics = measurement.tier;
  startPage(ctx, {
    eyebrow: "GOLD JOURNAL · TRADE REPORT",
    title: position.toUpperCase(),
    continued: `${position.toUpperCase()} — TRADE DATA (CONTINUED)`,
    caption: tradeHeaderMeta(model),
    titleSize: metrics.title,
    metrics,
  });
  renderKpiStrip(ctx, model);

  const column = columnWidth(ctx);
  const blocks = tradePageBlocks(ctx, model, column);
  const columnsTop = ctx.y;
  // Left column, then right column: the reading order of the field sections.
  ctx.y = columnsTop;
  for (const block of blocks.left) renderCompiledBlock(ctx, block, PDF_PAGE.margin, column);
  const leftBottom = ctx.y;
  ctx.y = columnsTop;
  for (const block of blocks.right) renderCompiledBlock(ctx, block, PDF_PAGE.margin + column + metrics.gap, column);
  const rightBottom = ctx.y;

  // Band 5-6: the checklist beside the recorded mistake categories.
  const bandTop = Math.max(leftBottom, rightBottom) + 2;
  ctx.y = bandTop;
  renderCompiledBlock(ctx, blocks.checklist, PDF_PAGE.margin, column);
  const checklistBottom = ctx.y;
  ctx.y = bandTop;
  renderCompiledBlock(ctx, blocks.categories, PDF_PAGE.margin + column + metrics.gap, column);
  ctx.y = Math.max(checklistBottom, ctx.y) + 2;

  // Section 7: psychology as three equal columns.
  const psychologyTop = ctx.y;
  const psychologyHeight = blocks.psychologyHeight - metrics.sectionAdvance;
  sectionHeading(ctx, "7 · Psychology", PDF_PAGE.margin, ctx.contentWidth);
  const psychologyCells = [
    { label: "Before trade", lines: blocks.psychologyLines[0] },
    { label: "During trade", lines: blocks.psychologyLines[1] },
    { label: "After trade", lines: blocks.psychologyLines[2] },
  ];
  const cellWidth = (ctx.contentWidth - metrics.gap * 2) / 3;
  psychologyCells.forEach((cell, cellIndex) => {
    const x = PDF_PAGE.margin + cellIndex * (cellWidth + metrics.gap);
    panel(ctx, x, psychologyTop, cellWidth, psychologyHeight, [250, 250, 249], PDF_COLORS.rule);
    ctx.doc.setFontSize(metrics.label);
    setText(ctx.doc, PDF_COLORS.inkSoft);
    ctx.doc.text(cell.label.toUpperCase(), x + 3, psychologyTop + 4);
    ctx.doc.setFontSize(metrics.body);
    setText(ctx.doc, PDF_COLORS.ink);
    cell.lines.forEach((line, lineIndex) => ctx.doc.text(line, x + 3, psychologyTop + 7 + lineIndex * metrics.line));
  });
  ctx.y = psychologyTop + psychologyHeight + 2.5;

  // Section 8: the journal note gets the remaining space, and continues onto a
  // dedicated page only when the entry genuinely does not fit.
  const noteTop = ctx.y;
  const note = blocks.note;
  if (noteTop + note.height <= ctx.bottom) {
    renderCompiledBlock(ctx, note, PDF_PAGE.margin, ctx.contentWidth);
  } else {
    sectionHeading(ctx, note.title, PDF_PAGE.margin, ctx.contentWidth);
    const lines = ctx.doc.splitTextToSize(note.kind === "note" ? note.text : "", ctx.contentWidth - 6) as string[];
    const room = Math.max(1, Math.floor((ctx.bottom - ctx.y - 4) / metrics.line));
    const firstPage = lines.slice(0, room);
    const rest = lines.slice(room);
    if (firstPage.length) {
      panel(ctx, PDF_PAGE.margin, ctx.y, ctx.contentWidth, firstPage.length * metrics.line + 5, [252, 252, 251], PDF_COLORS.rule);
      ctx.doc.setFontSize(metrics.body);
      setText(ctx.doc, PDF_COLORS.ink);
      firstPage.forEach((line, lineIndex) => ctx.doc.text(line, PDF_PAGE.margin + 3, ctx.y + 3.6 + lineIndex * metrics.line));
    }
    if (rest.length) {
      nextPage(ctx);
      sectionHeading(ctx, "8 · Journal note (continued)", PDF_PAGE.margin, ctx.contentWidth);
      // The continuation may itself span pages, so the text style is re-applied
      // for every line rather than once before the loop.
      rest.forEach(line => {
        ensureSpace(ctx, ctx.metrics.line);
        ctx.doc.setFontSize(metrics.body);
        setText(ctx.doc, PDF_COLORS.ink);
        ctx.doc.text(line, PDF_PAGE.margin, ctx.y);
        ctx.y += ctx.metrics.line;
      });
    }
  }

  if (blocks.extra) renderCompiledBlock(ctx, blocks.extra, PDF_PAGE.margin, ctx.contentWidth);
}

/* ------------------------------------------------------------------ *
 * Analysis pages
 * ------------------------------------------------------------------ */

function metricGrid(ctx: Ctx, items: { label: string; value: string; tone?: TradePdfTone }[], columns = METRIC_COLUMNS) {
  const metrics = ctx.metrics;
  const doc = ctx.doc;
  const width = (ctx.contentWidth - metrics.gap * (columns - 1)) / columns;
  const labelWidth = width * 0.5;
  for (let index = 0; index < items.length; index += columns) {
    const slice = items.slice(index, index + columns);
    doc.setFontSize(metrics.label);
    const cells = slice.map(item => {
      const inline = doc.splitTextToSize(item.label.toUpperCase(), labelWidth - 1).length === 1;
      doc.setFontSize(metrics.body);
      const lines = doc.splitTextToSize(item.value, Math.max(8, inline ? width - labelWidth - 2 : width)) as string[];
      return { item, inline, lines: lines.length ? lines : [PDF_MISSING] };
    });
    const height = Math.max(...cells.map(cell => (cell.inline ? 0 : metrics.labelLine) + cell.lines.length * metrics.line)) + metrics.rowGap;
    ensureSpace(ctx, height);
    cells.forEach((cell, cellIndex) => {
      const x = PDF_PAGE.margin + cellIndex * (width + metrics.gap);
      doc.setFontSize(metrics.label);
      setText(doc, PDF_COLORS.inkSoft);
      doc.text(cell.item.label.toUpperCase(), x, ctx.y);
      doc.setFontSize(metrics.body);
      setText(doc, toneColor(cell.item.tone, cell.item.value));
      const top = ctx.y + (cell.inline ? 0 : metrics.labelLine);
      cell.lines.forEach((line, lineIndex) => doc.text(line, cell.inline ? x + labelWidth : x, top + lineIndex * metrics.line));
    });
    ctx.y += height;
  }
}

/** The analysis headline cards: larger figures, one per metric. */
function renderKpiCards(ctx: Ctx, items: { label: string; value: string; tone?: TradePdfTone }[]) {
  const metrics = ctx.metrics;
  const count = Math.max(1, Math.min(items.length, KPI_COLUMNS));
  const width = (ctx.contentWidth - metrics.gap * (count - 1)) / count;
  const height = 19;
  ensureSpace(ctx, height + 4);
  items.slice(0, KPI_COLUMNS).forEach((item, index) => {
    const x = PDF_PAGE.margin + index * (width + metrics.gap);
    panel(ctx, x, ctx.y, width, height, PDF_COLORS.panel, PDF_COLORS.panelLine);
    ctx.doc.setFontSize(PDF_MIN_FONT);
    setText(ctx.doc, PDF_COLORS.inkSoft);
    ctx.doc.text(item.label.toUpperCase(), x + 4, ctx.y + 6);
    ctx.doc.setFontSize(13);
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "bold");
    setText(ctx.doc, toneColor(item.tone, item.value));
    ctx.doc.text(ctx.doc.splitTextToSize(item.value, width - 8)[0] ?? PDF_MISSING, x + 4, ctx.y + 14.4);
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "normal");
  });
  ctx.doc.setFontSize(metrics.body);
  ctx.y += height + 5;
}

function tableColumnWidths(table: AnalysisTable, width: number) {
  const total = table.columns.reduce((sum, column) => sum + column.flex, 0) || 1;
  return table.columns.map(column => (width * column.flex) / total);
}

/** The vertical space a table's title, header rule, and first row need. */
const TABLE_HEADER_BLOCK = 2.2 + 1 + TABLE_FONT.line;

/**
 * The exact height `renderTable` will consume, so a pair of tables only moves to
 * another page when it genuinely does not fit.
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

/** Draws a table with a clear header rule, repeating it after a page break. */
function renderTable(ctx: Ctx, table: AnalysisTable, width: number, x: number = PDF_PAGE.margin) {
  const doc = ctx.doc;
  const perCell = tableColumnWidths(table, width);
  const drawHeader = () => {
    doc.setFontSize(TABLE_FONT.title);
    if (doc.setFont) doc.setFont("helvetica", "bold");
    setText(doc, PDF_COLORS.ink);
    doc.text(table.title.toUpperCase(), x, ctx.y);
    if (doc.setFont) doc.setFont("helvetica", "normal");
    ctx.y += 2.6;
    doc.setFontSize(TABLE_FONT.header);
    setText(doc, PDF_COLORS.inkSoft);
    let cursor = x;
    table.columns.forEach((column, index) => {
      doc.text(column.label.toUpperCase(), column.align === "right" ? cursor + perCell[index] : cursor, ctx.y, column.align === "right" ? { align: "right" } : undefined);
      cursor += perCell[index];
    });
    ctx.y += 1;
    hairline(ctx, ctx.y, x, width, PDF_COLORS.rule, 0.3);
    ctx.y += TABLE_FONT.line;
  };
  ensureSpace(ctx, TABLE_HEADER_BLOCK + 2);
  drawHeader();
  if (!table.rows.length) {
    doc.setFontSize(TABLE_FONT.body);
    setText(doc, PDF_COLORS.inkFaint);
    doc.text(table.empty, x, ctx.y);
    ctx.y += TABLE_FONT.line * 2;
    return;
  }
  table.rows.forEach((row, rowIndex) => {
    doc.setFontSize(TABLE_FONT.body);
    const wrapped: string[][] = row.map((value: string, index: number) => {
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
    wrapped.forEach((lines: string[], index: number) => {
      const column = table.columns[index];
      const isNumeric = column.align === "right";
      setText(doc, isNumeric ? toneColor("signed", lines[0]) : PDF_COLORS.ink);
      lines.forEach((line: string, lineIndex: number) => {
        doc.text(line, isNumeric ? cursor + perCell[index] : cursor, ctx.y + lineIndex * TABLE_FONT.line, isNumeric ? { align: "right" } : undefined);
      });
      cursor += perCell[index];
    });
    ctx.y += height;
    if (rowIndex < table.rows.length - 1) hairline(ctx, ctx.y - TABLE_FONT.padding + 0.3, x, width, PDF_COLORS.panelLine, 0.15);
  });
  ctx.y += 2.4;
}

function renderAnalysisBlock(ctx: Ctx, block: AnalysisBlock) {
  if (block.kind === "heading") { sectionHeading(ctx, block.title, PDF_PAGE.margin, ctx.contentWidth, { accent: true }); return; }
  // The cards are self-labelling, so the KPI band needs no heading; every metric
  // grid does, otherwise its title would be silently dropped from the page.
  if (block.kind === "kpis") { renderKpiCards(ctx, block.items); return; }
  if (block.kind === "metrics") {
    if (block.title) sectionHeading(ctx, block.title, PDF_PAGE.margin, ctx.contentWidth);
    metricGrid(ctx, block.items);
    return;
  }
  if (block.kind === "table") { renderTable(ctx, block.table, ctx.contentWidth); return; }
  if (block.kind === "tableRow") {
    const gap = ctx.metrics.gap;
    const half = (ctx.contentWidth - gap) / 2;
    const tallest = Math.max(0, ...block.tables.map(table => measureTable(ctx, table, half)));
    if (ctx.y + tallest > ctx.bottom) {
      // Side by side no longer fits: render each table across the full width so
      // the remaining space on this page is still used.
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
  if (block.title) sectionHeading(ctx, block.title, PDF_PAGE.margin, ctx.contentWidth);
  if (block.flow) {
    writeWrapped(ctx, block.lines.join(" · "), { color: PDF_COLORS.inkSoft, lineHeight: 3.5, fontSize: ANALYSIS_METRICS.body });
    return;
  }
  for (const line of block.lines) {
    ensureSpace(ctx, 3.6);
    ctx.doc.setFontSize(ANALYSIS_METRICS.body);
    setText(ctx.doc, PDF_COLORS.accent);
    ctx.doc.text("•", PDF_PAGE.margin, ctx.y);
    writeWrapped(ctx, line, { x: PDF_PAGE.margin + 4, maxWidth: ctx.contentWidth - 4, color: PDF_COLORS.ink, lineHeight: 3.6, fontSize: ANALYSIS_METRICS.body });
  }
  ctx.y += 1.5;
}

type ParagraphBlock = Extract<AnalysisBlock, { kind: "paragraph" }>;

/** The height a bullet block occupies at a given width, so columns can balance. */
function measureParagraphBlock(ctx: Ctx, block: ParagraphBlock, width: number) {
  const metrics = ANALYSIS_METRICS;
  let height = block.title ? metrics.sectionAdvance : 0;
  ctx.doc.setFontSize(metrics.body);
  if (block.flow) {
    const lines = ctx.doc.splitTextToSize(block.lines.join(" · "), width) as string[];
    return height + Math.max(1, lines.length) * 3.5 + 3;
  }
  for (const line of block.lines) {
    const wrapped = ctx.doc.splitTextToSize(line, width - 4) as string[];
    height += Math.max(1, wrapped.length) * 3.6 + 0.4;
  }
  return height + 2;
}

function renderParagraphBlock(ctx: Ctx, block: ParagraphBlock, x: number, width: number) {
  if (block.title) sectionHeading(ctx, block.title, x, width);
  if (block.flow) {
    writeWrapped(ctx, block.lines.join(" · "), { x, maxWidth: width, color: PDF_COLORS.inkSoft, lineHeight: 3.5, fontSize: ANALYSIS_METRICS.body });
    ctx.y += 3;
    return;
  }
  for (const line of block.lines) {
    ensureSpace(ctx, 3.6);
    ctx.doc.setFontSize(ANALYSIS_METRICS.body);
    setText(ctx.doc, PDF_COLORS.accent);
    ctx.doc.text("•", x, ctx.y);
    writeWrapped(ctx, line, { x: x + 4, maxWidth: width - 4, color: PDF_COLORS.ink, lineHeight: 3.6, fontSize: ANALYSIS_METRICS.body });
  }
  ctx.y += 2;
}

/**
 * Renders the review page in two balanced columns.
 *
 * The review is prose, not a table, so a single 273 mm column would waste half of
 * every line; two columns let the whole page be read at once without shrinking
 * the type. If the columns still do not fit (an unusually long period), the blocks
 * fall back to sequential full-width rendering, which paginates normally.
 */
function renderTwoColumnParagraphs(ctx: Ctx, blocks: ParagraphBlock[]) {
  const gap = ANALYSIS_METRICS.gap;
  const width = (ctx.contentWidth - gap) / 2;
  const columns: Array<{ blocks: ParagraphBlock[]; height: number }> = [{ blocks: [], height: 0 }, { blocks: [], height: 0 }];
  for (const block of blocks) {
    const target = columns[0].height <= columns[1].height ? columns[0] : columns[1];
    target.blocks.push(block);
    target.height += measureParagraphBlock(ctx, block, width);
  }
  const tallest = Math.max(...columns.map(column => column.height));
  if (ctx.y + tallest > ctx.bottom) {
    for (const block of blocks) renderParagraphBlock(ctx, block, PDF_PAGE.margin, ctx.contentWidth);
    return;
  }
  const startY = ctx.y;
  columns.forEach((column, index) => {
    ctx.y = startY;
    const x = PDF_PAGE.margin + index * (width + gap);
    for (const block of column.blocks) renderParagraphBlock(ctx, block, x, width);
  });
  ctx.y = startY + tallest;
}

function renderAnalysisPage(ctx: Ctx, page: AnalysisPage, rangeLabel: string, mode: "ALL_TIME" | "RANGE", total: number) {
  startPage(ctx, {
    eyebrow: page.eyebrow,
    title: page.title,
    continued: `${page.title} (continued)`,
    caption: `${mode === "ALL_TIME" ? "Whole trade log" : "Selected period"} · ${rangeLabel} · ${total} exported trade${total === 1 ? "" : "s"}`,
    titleSize: 17,
    metrics: ANALYSIS_METRICS,
  });
  writeWrapped(ctx, page.caption, { color: PDF_COLORS.inkSoft, lineHeight: 3.5, fontSize: 7.2 });
  ctx.y += 3;
  const prose = page.blocks.filter((block): block is ParagraphBlock => block.kind === "paragraph");
  const structured = page.blocks.filter(block => block.kind !== "paragraph");
  for (const block of structured) renderAnalysisBlock(ctx, block);
  if (prose.length && page.twoColumn) renderTwoColumnParagraphs(ctx, prose);
  else for (const block of prose) renderAnalysisBlock(ctx, block);
}

/* ------------------------------------------------------------------ *
 * Empty report and footers
 * ------------------------------------------------------------------ */

function renderEmptyReport(ctx: Ctx, options: TradeLogPdfOptions) {
  startPage(ctx, {
    eyebrow: "GOLD JOURNAL · PERFORMANCE REPORT",
    title: "No trades found for the selected period",
    continued: "No trades found",
    titleSize: 18,
    metrics: ANALYSIS_METRICS,
  });
  ctx.doc.setFontSize(9);
  writeWrapped(ctx, `Account: ${options.accountName}`, { color: PDF_COLORS.ink, lineHeight: 4.4, fontSize: 9 });
  writeWrapped(ctx, `Selected date range: ${options.rangeLabel}`, { color: PDF_COLORS.ink, lineHeight: 4.4, fontSize: 9 });
  ctx.y += 3;
  writeWrapped(ctx, "No trade matched the selected account and date range, so there is nothing to export. Change the range, or add trades to this account, and run the export again.", { color: PDF_COLORS.inkSoft, lineHeight: 4.4, fontSize: 8.6 });
}

function renderFooters(doc: PdfDoc, options: TradeLogPdfOptions, total: number) {
  const label = `Gold Journal · ${options.accountName} · ${options.rangeLabel}`;
  for (let page = 1; page <= total; page += 1) {
    doc.setPage(page);
    doc.setFontSize(6.4);
    setText(doc, PDF_COLORS.inkFaint);
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
 * screenshot evidence), the four analysis pages, and a footer on every page — all
 * from the same exported trade set, with one screenshot fetch per unique URL.
 */
export async function renderTradeLogPdf(doc: PdfDoc, options: TradeLogPdfOptions) {
  const ctx: Ctx = {
    doc,
    started: false,
    y: PDF_PAGE.margin,
    bodyTop: PDF_PAGE.margin,
    bottom: contentBottom(),
    contentWidth: contentWidth(),
    metrics: TRADE_METRICS[1],
    header: { eyebrow: "", title: "", continued: "" },
    titleSize: 16,
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
    const position = `Trade ${String(index + 1).padStart(2, "0")} / ${String(options.trades.length).padStart(2, "0")}`;
    renderTradeDataPage(ctx, model, index, options.trades.length);
    await renderScreenshotPage(ctx, { model, position, fetchImage });
  }
  const analysis = options.analysis ?? buildPeriodAnalysis(options.trades.map(row => row.trade), { accountName: options.accountName, rangeLabel: options.rangeLabel });
  for (const page of analysis.pages) renderAnalysisPage(ctx, page, options.rangeLabel, options.mode, analysis.total);
  const total = doc.getNumberOfPages();
  renderFooters(doc, options, total);
  return { pages: total, trades: options.trades.length, summary: options.summary, analysis };
}
