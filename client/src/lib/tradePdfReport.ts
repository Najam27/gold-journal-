/**
 * The PDF report renderer.
 *
 * Design contract (a fixed, deliberately constructed document):
 *   • A4 landscape, neutral white page, dark ink, and a *section-coded* colour
 *     system taken from `TRADE_SECTION_THEME` — so the dialog, the share card, and
 *     the PDF all mark "Strategy" purple and "Risk & performance" amber. The
 *     document carries its own print palette, so neither the app theme (light or
 *     dark) nor a dark-mode class can change how it reads or prints;
 *   • two pages per trade: a complete trade-data page (coloured section bands, a
 *     KPI tile strip, and a table of every canonical field) and a screenshot
 *     evidence page;
 *   • analysis pages after the trades — performance, process, psychology, review —
 *     each answering one question, using the same coloured band language;
 *   • a footer on every page with the account, the period, and `Page X / Y`.
 *
 * It never decides what a trade contains: every value comes from
 * `buildTradePresentation` (the canonical presentation model the Trade Card and
 * the share image also render), and the analysis pages come from
 * `buildPeriodAnalysis` (computed by `@shared/analysisEngine`). No technical
 * plumbing — MT5 ticket numbers, screenshot file names, storage details, image
 * formats, or internal ids — is ever drawn.
 *
 * Layout rule: every row's height is measured from its own wrapped text before it
 * is drawn, so a long value grows its row instead of colliding with the row below.
 * A value that genuinely cannot fit continues onto a labelled continuation page —
 * nothing is truncated and no read text is driven below 7pt.
 *
 * A `PdfDoc` is passed in rather than a concrete jsPDF instance, so the layout,
 * pagination, and screenshot fitting rules are unit-testable in Node while the
 * application passes a real jsPDF document.
 */

import {
  PRESENTATION_MISSING,
  TRADE_HEADER_ACCENT,
  TRADE_SECTION_THEME,
  buildTradePresentation,
  resolveTone,
  type TradePresentation,
  type TradePresentationChecklistItem,
  type TradePresentationField,
  type TradePresentationSectionId,
  type TradeTone,
} from "./tradePresentation";
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

type Rgb = readonly [number, number, number];

/** Converts a canonical `#rrggbb` theme colour into a jsPDF channel triple. */
export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

/**
 * The document's own print palette: a neutral page, dark ink, fixed
 * positive/negative treatment, and the tinted panels the section bands use.
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
  onAccent: [255, 255, 255],
  tintPositive: [238, 247, 242],
  tintNegative: [252, 240, 240],
  tintWarning: [253, 247, 235],
  tintAccent: [242, 246, 253],
} as const;

/** The canonical section accents, resolved once for the document. */
export const PDF_SECTION_COLORS: Record<TradePresentationSectionId, Rgb> = {
  overview: hexToRgb(TRADE_SECTION_THEME.overview.accent),
  strategy: hexToRgb(TRADE_SECTION_THEME.strategy.accent),
  execution: hexToRgb(TRADE_SECTION_THEME.execution.accent),
  risk: hexToRgb(TRADE_SECTION_THEME.risk.accent),
  discipline: hexToRgb(TRADE_SECTION_THEME.discipline.accent),
  checklist: hexToRgb(TRADE_SECTION_THEME.checklist.accent),
  mistakes: hexToRgb(TRADE_SECTION_THEME.mistakes.accent),
  psychology: hexToRgb(TRADE_SECTION_THEME.psychology.accent),
  journal: hexToRgb(TRADE_SECTION_THEME.journal.accent),
};

export const PDF_HEADER_COLOR: Rgb = hexToRgb(TRADE_HEADER_ACCENT);

/** Shown when a screenshot was recorded but could not be embedded. */
export const SCREENSHOT_EMBED_FAILURE = "The screenshot could not be loaded for this export.";

const TONE_COLORS: Record<TradeTone, Rgb> = {
  neutral: PDF_COLORS.ink,
  positive: PDF_COLORS.positive,
  negative: PDF_COLORS.negative,
  signed: PDF_COLORS.ink,
  accent: PDF_COLORS.accent,
  warning: PDF_COLORS.warning,
};

const TONE_TINTS: Record<TradeTone, Rgb> = {
  neutral: PDF_COLORS.panel,
  signed: PDF_COLORS.panel,
  positive: PDF_COLORS.tintPositive,
  negative: PDF_COLORS.tintNegative,
  accent: PDF_COLORS.tintAccent,
  warning: PDF_COLORS.tintWarning,
};

function toneColor(tone: TradeTone | undefined, value?: string): Rgb {
  const resolved = tone === "signed" && value ? resolveTone({ tone, value }) : tone ?? "neutral";
  if (resolved === "signed") return PDF_COLORS.ink;
  return TONE_COLORS[resolved] ?? PDF_COLORS.ink;
}

function toneTint(tone: TradeTone | undefined, value?: string): Rgb {
  const resolved = tone === "signed" && value ? resolveTone({ tone, value }) : tone ?? "neutral";
  return TONE_TINTS[resolved] ?? PDF_COLORS.panel;
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
 * Readable first, compact second: the first tier that fits the page wins. No tier
 * drops a label, heading, or value below 7pt — a trade that genuinely cannot be
 * laid out at 7pt continues onto a labelled page instead of shrinking further.
 */
const TRADE_METRICS: Metrics[] = [
  { body: 8, line: 3.5, label: 7.4, labelLine: 3, gap: 7, rowGap: 1.2, section: 8, sectionAdvance: 4.4, title: 17 },
  { body: 7.8, line: 3.3, label: 7.3, labelLine: 2.9, gap: 6.5, rowGap: 1, section: 7.8, sectionAdvance: 4.2, title: 16 },
  { body: 7.5, line: 3.1, label: 7.2, labelLine: 2.8, gap: 6, rowGap: 0.8, section: 7.6, sectionAdvance: 4, title: 16 },
  { body: 7.2, line: 3, label: 7.1, labelLine: 2.7, gap: 5.5, rowGap: 0.6, section: 7.4, sectionAdvance: 3.9, title: 15 },
  { body: 7, line: 2.9, label: 7, labelLine: 2.6, gap: 5, rowGap: 0.5, section: 7.2, sectionAdvance: 3.8, title: 15 },
];

const ANALYSIS_METRICS: Metrics = { body: 7.6, line: 3.4, label: 7.2, labelLine: 3, gap: 6, rowGap: 1.1, section: 8, sectionAdvance: 4.8, title: 16 };
const TABLE_FONT = { title: 7.6, header: 7, body: 7.2, line: 3.4, padding: 0.8 };

/**
 * The smallest type the report's read content uses: eyebrows, KPI labels, field
 * labels, table headers, and body text all stay at or above this.
 */
export const PDF_MIN_FONT = 7;
const METRIC_COLUMNS = 4;
const KPI_COLUMNS = 6;

/** Height of the page header band, and of the body area it leaves behind. */
const HEADER_HEIGHT = 15;
const SCREENSHOT_CAPTION = 5;
/** Height of the trade page's KPI tile strip, including its gap. */
const KPI_STRIP_HEIGHT = 14;

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
function contentBottom() { return PDF_PAGE.height - PDF_PAGE.margin - 6; }

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
  doc.text(doc.splitTextToSize(title, contentWidth())[0] ?? "", margin, margin + 9.8);
  if (doc.setFont) doc.setFont("helvetica", "normal");
  if (ctx.header.caption) {
    setText(doc, PDF_COLORS.inkSoft);
    doc.setFontSize(7.4);
    doc.text(doc.splitTextToSize(ctx.header.caption, contentWidth())[0] ?? "", margin, margin + 13.4);
  }
  hairline(ctx, margin + 14.6, margin, contentWidth(), PDF_HEADER_COLOR, 0.6);
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

/** A filled, coloured section band with its title in white — the report's anchor. */
function sectionBand(ctx: Ctx, title: string, color: Rgb, x: number, width: number, options: { height?: number } = {}) {
  const height = options.height ?? ctx.metrics.sectionAdvance;
  ensureSpace(ctx, height + 2);
  panel(ctx, x, ctx.y, width, height, color, color);
  // The band title is display type, but it still never drops below the floor.
  ctx.doc.setFontSize(Math.max(PDF_MIN_FONT, ctx.metrics.section - 0.4));
  if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "bold");
  setText(ctx.doc, PDF_COLORS.onAccent);
  ctx.doc.text(title.toUpperCase(), x + 2.4, ctx.y + height - 1.5);
  if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "normal");
  ctx.y += height;
}

/* ------------------------------------------------------------------ *
 * Text utilities
 * ------------------------------------------------------------------ */

/** Turns a value made of many short lines (a tag list) into one flowing line. */
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
  return lines.length ? lines : [PRESENTATION_MISSING];
}

/**
 * Writes wrapped text from x. Font and colour are re-applied per line because a
 * page break resets both (the page header sets its own type size).
 */
function writeWrapped(ctx: Ctx, value: string, options: { x?: number; maxWidth?: number; lineHeight?: number; color?: Rgb; fontSize?: number } = {}) {
  const x = options.x ?? PDF_PAGE.margin;
  const lineHeight = options.lineHeight ?? ctx.metrics.line;
  const maxWidth = options.maxWidth ?? ctx.contentWidth;
  const fontSize = options.fontSize ?? ctx.metrics.body;
  const color = options.color ?? PDF_COLORS.ink;
  for (const line of wrapText(ctx.doc, value, maxWidth)) {
    ensureSpace(ctx, lineHeight);
    ctx.doc.setFontSize(fontSize);
    setText(ctx.doc, color);
    ctx.doc.text(line, x, ctx.y);
    ctx.y += lineHeight;
  }
}

/* ------------------------------------------------------------------ *
 * Trade page blocks
 * ------------------------------------------------------------------ */

type Cell = {
  key: string;
  label: string;
  value: string;
  lines: string[];
  labelLines: string[];
  stacked: boolean;
  tone?: TradeTone;
};

type Block =
  | { kind: "section"; id: string; title: string; accent: Rgb; rows: Array<{ cells: Cell[]; height: number }>; height: number }
  | { kind: "checklist"; id: "checklist"; title: string; accent: Rgb; columns: TradePresentationChecklistItem[][]; rowHeight: number; height: number }
  | { kind: "process"; id: "process"; title: string; accent: Rgb; label: string; summary: string; reviewLines: string[]; tone: TradeTone; height: number }
  | { kind: "psychology"; id: "psychology"; title: string; accent: Rgb; cells: Array<{ label: string; lines: string[] }>; height: number }
  | { kind: "note"; id: "journal"; title: string; accent: Rgb; label: string; text: string; lines: string[]; height: number };

function columnWidth(ctx: Ctx) { return (ctx.contentWidth - ctx.metrics.gap) / 2; }

/**
 * Measures one field cell at the width it will occupy.
 *
 * `stacked` is decided by the caller when the cell was first probed at the grid's
 * cell width and found to need a whole row; it is then re-measured at the full row
 * width while staying stacked. Deciding it again after that re-measure is what
 * once let a long label run underneath its own value.
 */
function buildCell(ctx: Ctx, field: TradePresentationField, width: number, stacked?: boolean): Cell {
  const metrics = ctx.metrics;
  const value = compactListValue(field.value);
  // Inline label/value keeps a compact row; a long label or value stacks so the
  // text can use the full cell width instead of colliding with its neighbour.
  const labelWidth = width * 0.44;
  const valueWidth = width - labelWidth - 2;
  ctx.doc.setFontSize(metrics.label);
  const labelLines = ctx.doc.splitTextToSize(field.label.toUpperCase(), labelWidth - 0.5) as string[];
  const layoutStacked = stacked ?? (labelLines.length > 1 || field.wide === true);
  ctx.doc.setFontSize(metrics.body);
  const lines = ctx.doc.splitTextToSize(value, layoutStacked ? width : valueWidth) as string[];
  return { key: field.key, label: field.label.toUpperCase(), value, lines: lines.length ? lines : [PRESENTATION_MISSING], labelLines: labelLines.length ? labelLines : [field.label.toUpperCase()], stacked: layoutStacked, tone: field.tone };
}

function cellHeight(cell: Cell, metrics: Metrics) {
  const labelBlock = cell.stacked ? cell.labelLines.length * metrics.labelLine : 0;
  const valueBlock = cell.lines.length * metrics.line;
  return labelBlock + valueBlock + metrics.rowGap;
}

/**
 * A section as a table: coloured band, then rows of up to `columns` field cells.
 * A `wide` field (long prose) always takes a full row. Each row's height is the
 * tallest cell in it, so a wrapped value grows its own row and never overlaps the
 * row below.
 */
function compileSection(ctx: Ctx, model: TradePresentation, id: TradePresentationSectionId, width: number, columns: number, options: { skip?: string[] } = {}): Block | null {
  const metrics = ctx.metrics;
  const section = model.sections.find(entry => entry.id === id);
  if (!section) return null;
  const skip = new Set(options.skip ?? []);
  const fields = section.fields.filter(field => !field.inHeader && !skip.has(field.key));
  if (!fields.length) return null;
  // A cell is measured against the width it will actually occupy: a field whose
  // label or value needs a whole row is measured at full width, the rest at the
  // grid's cell width. Measuring all of them at the full width is what let a long
  // label run under its own value.
  const cellWidth = (width - metrics.gap * (columns - 1)) / columns;
  const cells = fields.map(field => {
    const probe = buildCell(ctx, field, cellWidth);
    // The model's `wide` hint means "this value can be long", not "this value must
    // own a whole row": a short tagged value still pairs with its neighbour, and
    // only prose that genuinely needs the width takes a row of its own.
    const fullRow = probe.stacked || (field.wide === true && probe.lines.length > 2);
    return fullRow ? buildCell(ctx, field, width, true) : probe;
  });
  const rows: Array<{ cells: Cell[]; height: number }> = [];
  let current: Cell[] = [];
  const flush = () => {
    if (!current.length) return;
    rows.push({ cells: current, height: Math.max(...current.map(cell => cellHeight(cell, metrics))) });
    current = [];
  };
  for (const cell of cells) {
    if (cell.stacked) { flush(); rows.push({ cells: [cell], height: cellHeight(cell, metrics) }); continue; }
    if (current.length >= columns) flush();
    current.push(cell);
  }
  flush();
  return { kind: "section", id, title: section.title, accent: PDF_SECTION_COLORS[id], rows, height: metrics.sectionAdvance + rows.reduce((sum, row) => sum + row.height, 0) + 1.5 };
}

/** The checklist as two columns of confirmed / not-confirmed items. */
function compileChecklist(ctx: Ctx, model: TradePresentation): Block {
  const metrics = ctx.metrics;
  const half = Math.ceil(model.checklist.length / 2);
  const columns = [model.checklist.slice(0, half), model.checklist.slice(half)];
  const rowHeight = metrics.line + 0.4;
  const height = metrics.sectionAdvance + Math.max(...columns.map(column => column.length)) * rowHeight + 1.5;
  return { kind: "checklist", id: "checklist", title: TRADE_SECTION_THEME.checklist.title, accent: PDF_SECTION_COLORS.checklist, columns, rowHeight, height };
}

/** The process verdict, shown as its own tinted panel so P&L never implies process. */
function compileProcess(ctx: Ctx, model: TradePresentation, width: number): Block {
  const metrics = ctx.metrics;
  ctx.doc.setFontSize(metrics.body);
  const summaryLines = (ctx.doc.splitTextToSize(model.classification.summary, width - 8) as string[]).slice(0, 2);
  const review = model.sections.find(section => section.id === "discipline")?.fields.find(field => field.key === "processReview")?.value ?? PRESENTATION_MISSING;
  const reviewLines = (ctx.doc.splitTextToSize(review, width - 4) as string[]).slice(0, 3);
  // Band + classification panel (label, summary) + "process review" caption + lines.
  const height = metrics.sectionAdvance + 8 + summaryLines.length * metrics.line + 3 + metrics.labelLine + reviewLines.length * metrics.line + 1.5;
  return {
    kind: "process",
    id: "process",
    title: "Process",
    accent: PDF_SECTION_COLORS.discipline,
    label: model.classification.label,
    summary: model.classification.summary,
    reviewLines,
    tone: model.classification.tone,
    height,
  };
}

/** Psychology as three equal columns — before / during / after. */
function compilePsychology(ctx: Ctx, model: TradePresentation, width: number): Block {
  const metrics = ctx.metrics;
  const cellWidth = (width - metrics.gap * 2) / 3;
  ctx.doc.setFontSize(metrics.body);
  const values = [model.psychology.before, model.psychology.during, model.psychology.after];
  // The labels come from the canonical model, so the report cannot print a
  // different wording for "before / during / after" than the Trade Card does.
  const labels = (model.sections.find(section => section.id === "psychology")?.fields ?? []).map(field => field.label);
  const cells = values.map((value, index) => ({
    label: labels[index] ?? TRADE_SECTION_THEME.psychology.title,
    lines: ctx.doc.splitTextToSize(value.trim() === "" ? PRESENTATION_MISSING : value, cellWidth - 6) as string[],
  }));
  const height = metrics.sectionAdvance + 4 + Math.max(1, ...cells.map(cell => cell.lines.length)) * metrics.line + 3;
  return { kind: "psychology", id: "psychology", title: TRADE_SECTION_THEME.psychology.title, accent: PDF_SECTION_COLORS.psychology, cells, height };
}

/**
 * The journal note, measured in the box it will occupy.
 *
 * An ordinary note sits beside the psychology block — the two then share one band
 * row instead of stacking, which is most of what keeps a populated trade on a
 * single page. A genuinely long entry takes the full width instead, so it wraps in
 * half as many lines before it has to continue onto another page.
 */
function compileNote(ctx: Ctx, model: TradePresentation, width: number): Extract<Block, { kind: "note" }> {
  const metrics = ctx.metrics;
  const label = model.sections.find(section => section.id === "journal")?.fields[0]?.label ?? TRADE_SECTION_THEME.journal.title;
  ctx.doc.setFontSize(metrics.body);
  const value = model.journalNotes.trim() === "" ? PRESENTATION_MISSING : model.journalNotes;
  const lines = ctx.doc.splitTextToSize(value, width - 6) as string[];
  return { kind: "note", id: "journal", title: TRADE_SECTION_THEME.journal.title, accent: PDF_SECTION_COLORS.journal, label, text: value, lines, height: metrics.sectionAdvance + metrics.labelLine + Math.max(1, lines.length) * metrics.line + 6 };
}

function renderBlock(ctx: Ctx, block: Block, x: number, width: number) {
  const metrics = ctx.metrics;
  const doc = ctx.doc;
  ensureSpace(ctx, block.height);
  sectionBand(ctx, block.title, block.accent, x, width);

  if (block.kind === "section") {
    block.rows.forEach((row, rowIndex) => {
      // A row with fewer cells than the section's grid is wider than measured; the
      // pre-wrapped lines are redrawn as they are, so the row height still holds.
      const cellWidth = row.cells.length === 1 ? width : (width - metrics.gap * (row.cells.length - 1)) / row.cells.length;
      let cursor = x;
      for (const cell of row.cells) {
        doc.setFontSize(metrics.label);
        setText(doc, PDF_COLORS.inkSoft);
        cell.labelLines.forEach((line, index) => doc.text(line, cursor, ctx.y + metrics.labelLine - 0.4 + index * metrics.labelLine));
        const valueTop = cell.stacked ? ctx.y + cell.labelLines.length * metrics.labelLine : ctx.y;
        doc.setFontSize(metrics.body);
        setText(doc, toneColor(cell.tone, cell.value));
        const valueX = cell.stacked ? cursor : cursor + cellWidth * 0.44;
        cell.lines.forEach((line, index) => doc.text(line, valueX, valueTop + metrics.line - 0.4 + index * metrics.line));
        cursor += cellWidth + metrics.gap;
      }
      ctx.y += row.height;
      if (rowIndex < block.rows.length - 1) hairline(ctx, ctx.y - metrics.rowGap + 0.2, x, width, PDF_COLORS.panelLine, 0.15);
    });
    ctx.y += 1.5;
    return;
  }

  if (block.kind === "checklist") {
    const half = (width - metrics.gap) / 2;
    block.columns.forEach((items, columnIndex) => {
      items.forEach((item, index) => {
        const lineY = ctx.y + index * block.rowHeight + metrics.line - 0.4;
        const mark = item.confirmed ? "✓" : "✗";
        doc.setFontSize(metrics.body);
        setText(doc, item.confirmed ? PDF_COLORS.positive : item.recorded ? PDF_COLORS.negative : PDF_COLORS.inkFaint);
        doc.text(mark, x + columnIndex * (half + metrics.gap), lineY);
        setText(doc, item.confirmed ? PDF_COLORS.ink : PDF_COLORS.inkSoft);
        doc.text(doc.splitTextToSize(item.label, half - 5)[0] ?? item.label, x + columnIndex * (half + metrics.gap) + 4, lineY);
      });
    });
    ctx.y += Math.max(...block.columns.map(column => column.length)) * block.rowHeight + 1.5;
    return;
  }

  if (block.kind === "process") {
    const fill = toneTint(block.tone);
    const summaryLines = (doc.splitTextToSize(block.summary, width - 8) as string[]).slice(0, 2);
    const boxHeight = 7 + summaryLines.length * metrics.line + 1.5;
    panel(ctx, x, ctx.y, width, boxHeight, fill, PDF_COLORS.panelLine);
    doc.setFontSize(10);
    if (doc.setFont) doc.setFont("helvetica", "bold");
    setText(doc, toneColor(block.tone));
    doc.text(block.label.toUpperCase(), x + 3.4, ctx.y + 6);
    if (doc.setFont) doc.setFont("helvetica", "normal");
    doc.setFontSize(metrics.body);
    setText(doc, PDF_COLORS.inkSoft);
    summaryLines.forEach((line, index) => doc.text(line, x + 3.4, ctx.y + 9.4 + index * metrics.line));
    let cursor = ctx.y + boxHeight + 2.4;
    doc.setFontSize(metrics.label);
    setText(doc, PDF_COLORS.inkSoft);
    doc.text("PROCESS REVIEW", x, cursor);
    cursor += metrics.labelLine;
    doc.setFontSize(metrics.body);
    setText(doc, PDF_COLORS.ink);
    for (const line of block.reviewLines) { doc.text(line, x, cursor); cursor += metrics.line; }
    ctx.y = cursor + 1.5;
    return;
  }

  if (block.kind === "psychology") {
    const cellWidth = (width - metrics.gap * 2) / 3;
    const lines = Math.max(1, ...block.cells.map(cell => cell.lines.length));
    const boxHeight = 4 + lines * metrics.line + 3;
    block.cells.forEach((cell, index) => {
      const cellX = x + index * (cellWidth + metrics.gap);
      panel(ctx, cellX, ctx.y, cellWidth, boxHeight, PDF_COLORS.panel, PDF_COLORS.panelLine);
      doc.setFontSize(metrics.label);
      setText(doc, PDF_COLORS.inkSoft);
      doc.text(cell.label.toUpperCase(), cellX + 2.6, ctx.y + 4);
      doc.setFontSize(metrics.body);
      setText(doc, PDF_COLORS.ink);
      cell.lines.forEach((line, lineIndex) => doc.text(line, cellX + 2.6, ctx.y + 7.4 + lineIndex * metrics.line));
    });
    ctx.y += boxHeight + 1.5;
    return;
  }

  // note: a bordered text box so the journal entry reads as one passage.
  const boxHeight = metrics.labelLine + Math.max(1, block.lines.length) * metrics.line + 5;
  panel(ctx, x, ctx.y, width, boxHeight, [252, 252, 251], PDF_COLORS.rule);
  doc.setFontSize(metrics.label);
  setText(doc, PDF_COLORS.inkSoft);
  doc.text(block.label.toUpperCase(), x + 3, ctx.y + 3.6);
  doc.setFontSize(metrics.body);
  setText(doc, PDF_COLORS.ink);
  block.lines.forEach((line, index) => doc.text(line, x + 3, ctx.y + 3.6 + metrics.labelLine + index * metrics.line));
  ctx.y += boxHeight + 1.5;
}

/* ------------------------------------------------------------------ *
 * KPI tiles
 * ------------------------------------------------------------------ */

function renderKpiStrip(ctx: Ctx, model: TradePresentation) {
  const kpis = model.kpis;
  if (!kpis.length) return;
  ensureSpace(ctx, KPI_STRIP_HEIGHT + 4);
  const count = Math.max(1, kpis.length);
  const gap = 1.6;
  const tileWidth = (ctx.contentWidth - gap * (count - 1)) / count;
  const height = KPI_STRIP_HEIGHT - 1;
  kpis.forEach((kpi, index) => {
    const x = PDF_PAGE.margin + index * (tileWidth + gap);
    panel(ctx, x, ctx.y, tileWidth, height, toneTint(kpi.tone, kpi.value), PDF_COLORS.panelLine);
    ctx.doc.setFontSize(PDF_MIN_FONT);
    setText(ctx.doc, PDF_COLORS.inkSoft);
    ctx.doc.text(kpi.label.toUpperCase(), x + 3, ctx.y + 5);
    ctx.doc.setFontSize(11.5);
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "bold");
    setText(ctx.doc, toneColor(kpi.tone, kpi.value));
    ctx.doc.text(ctx.doc.splitTextToSize(kpi.value, tileWidth - 6)[0] ?? PRESENTATION_MISSING, x + 3, ctx.y + 11.6);
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "normal");
  });
  ctx.doc.setFontSize(ctx.metrics.body);
  ctx.y += height + 3;
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

/** Browser-only WEBP to PNG upgrade; returns null when canvas is unavailable. */
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
 * One fetch per screenshot per export. A URL that fails is remembered as well, so
 * a broken screenshot is not retried for every page that mentions it.
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

type ScreenshotContext = { model: TradePresentation; position: string; fetchImage: (url: string) => Promise<PdfImage> };

/** The trade context a screenshot page shows: identity only, never file metadata. */
function evidenceLine(model: TradePresentation, position: string) {
  return [position, model.identity.tradeDate, model.identity.symbol, model.identity.direction, model.identity.result, model.identity.pnl]
    .filter(value => value !== PRESENTATION_MISSING)
    .join(" · ");
}

async function renderScreenshotPage(ctx: Ctx, options: ScreenshotContext) {
  const { model, position, fetchImage } = options;
  startPage(ctx, {
    eyebrow: "GOLD JOURNAL · SCREENSHOT EVIDENCE",
    title: "Screenshot evidence",
    continued: `${position.toUpperCase()} — SCREENSHOT EVIDENCE (CONTINUED)`,
    caption: evidenceLine(model, position).toUpperCase(),
    titleSize: 16,
    metrics: ANALYSIS_METRICS,
  });

  const evidence = model.evidence;

  if (!evidence.url) {
    const boxHeight = 78;
    const centerX = PDF_PAGE.margin + ctx.contentWidth / 2;
    // Centred in the page's free area, so the evidence page reads as a deliberate
    // empty state instead of a heading with a gap under it.
    const top = ctx.y + Math.max(0, (ctx.bottom - ctx.y - boxHeight - SCREENSHOT_CAPTION - 10) / 2);
    panel(ctx, PDF_PAGE.margin, top, ctx.contentWidth, boxHeight, [251, 251, 250], PDF_COLORS.rule);
    ctx.doc.setFontSize(11.5);
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "bold");
    setText(ctx.doc, evidence.hasScreenshot ? PDF_COLORS.warning : PDF_COLORS.inkSoft);
    ctx.doc.text(evidence.hasScreenshot ? "SCREENSHOT NOT AVAILABLE IN THIS EXPORT" : "NO SCREENSHOT ATTACHED", centerX, top + 32, { align: "center" });
    ctx.doc.setFontSize(8);
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "normal");
    setText(ctx.doc, PDF_COLORS.inkSoft);
    const message = evidence.hasScreenshot
      ? "A screenshot is stored for this trade, but it could not be loaded while the report was built. The trade data on the previous page is complete."
      : "No chart image is attached to this trade. Add one from Edit trade and it will appear here as the evidence page.";
    (ctx.doc.splitTextToSize(message, ctx.contentWidth - 60) as string[]).forEach((line, index) => ctx.doc.text(line, centerX, top + 41 + index * 4, { align: "center" }));
    ctx.doc.setFontSize(PDF_MIN_FONT);
    setText(ctx.doc, PDF_COLORS.inkSoft);
    ctx.doc.text(evidenceLine(model, position), centerX, top + boxHeight - 10, { align: "center" });
    ctx.y = top + boxHeight + SCREENSHOT_CAPTION;
    return;
  }

  try {
    // Fetched and measured first, so the image is fitted before anything is drawn.
    const image = await fetchImage(evidence.url);
    const properties = ctx.doc.getImageProperties(image.dataUrl);
    const width = Number(properties?.width);
    const height = Number(properties?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("Screenshot dimensions could not be read");
    const boxHeight = ctx.bottom - ctx.y - SCREENSHOT_CAPTION;
    if (boxHeight <= 20) throw new Error("No page space is available for the screenshot");
    // Contain, never stretch or crop. Small images are enlarged modestly (up to
    // 1.5x their natural print size) instead of being blown up to page width.
    const naturalWidth = width / 96 * 25.4;
    const naturalHeight = height / 96 * 25.4;
    const available = fitInside(Math.min(ctx.contentWidth, naturalWidth * 1.5), Math.min(boxHeight, naturalHeight * 1.5), width, height);
    const x = PDF_PAGE.margin + (ctx.contentWidth - available.width) / 2;
    const y = ctx.y + Math.max(0, (boxHeight - available.height) / 2);
    setDraw(ctx.doc, PDF_COLORS.rule);
    ctx.doc.rect(x - 0.6, y - 0.6, available.width + 1.2, available.height + 1.2, "S");
    ctx.doc.addImage(image.dataUrl, image.format, x, y, available.width, available.height);
    ctx.y = y + available.height + 3;
  } catch {
    // A single unreadable image never aborts the report, and no technical error is
    // ever shown to the trader.
    const top = ctx.y + Math.max(0, (ctx.bottom - ctx.y - 60) / 2);
    panel(ctx, PDF_PAGE.margin, top, ctx.contentWidth, 60, PDF_COLORS.tintNegative, [232, 196, 196]);
    const centerX = PDF_PAGE.margin + ctx.contentWidth / 2;
    ctx.doc.setFontSize(11);
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "bold");
    setText(ctx.doc, PDF_COLORS.negative);
    ctx.doc.text("SCREENSHOT COULD NOT BE LOADED", centerX, top + 24, { align: "center" });
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "normal");
    ctx.doc.setFontSize(7.8);
    setText(ctx.doc, PDF_COLORS.inkSoft);
    (ctx.doc.splitTextToSize(`${SCREENSHOT_EMBED_FAILURE} The trade data is unaffected and the report continues with the next trade.`, ctx.contentWidth - 60) as string[]).forEach((line, index) => ctx.doc.text(line, centerX, top + 33 + index * 3.8, { align: "center" }));
    ctx.doc.setFontSize(PDF_MIN_FONT);
    ctx.doc.text(evidenceLine(model, position), centerX, top + 50, { align: "center" });
    ctx.y = top + 60 + SCREENSHOT_CAPTION;
  }
}

/* ------------------------------------------------------------------ *
 * Trade page
 * ------------------------------------------------------------------ */

/**
 * Measures the trade data page for every typography tier.
 *
 * The first tier whose layout fits one page wins, so an ordinary trade is always
 * exactly one data page; the smallest tier is only used, and content only
 * continues onto another page, when the recorded data genuinely cannot be laid
 * out otherwise.
 */
export function measureTradeDataPage(doc: PdfDoc, model: TradePresentation) {
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
  left: Block[];
  right: Block[];
  checklist: Block;
  mistakes: Block;
  psychology: Block;
  note: Extract<Block, { kind: "note" }>;
  /** True when psychology and the note share one band row. */
  beside: boolean;
  /** Persisted properties the canonical model has no dedicated home for. */
  extra: Block | null;
};

function tradePageBlocks(ctx: Ctx, model: TradePresentation, column: number): TradePageBlocks {
  // Left column reads Overview, Strategy, Execution; right column reads Risk &
  // performance, Plan & discipline, Process. The two columns are the same table
  // continued, not two different field sets.
  const left: Block[] = [];
  const right: Block[] = [];
  const push = (list: Block[], block: Block | null) => { if (block) list.push(block); };
  push(left, compileSection(ctx, model, "overview", column, 2));
  push(left, compileSection(ctx, model, "strategy", column, 2));
  push(left, compileSection(ctx, model, "execution", column, 2));
  push(right, compileSection(ctx, model, "risk", column, 2));
  // Two columns here: the discipline labels ("Planned / unplanned", "Checklist
  // completion") are long, and a grid of three would stack them into extra rows.
  push(right, compileSection(ctx, model, "discipline", column, 2, { skip: ["processReview"] }));
  push(right, compileProcess(ctx, model, column));
  const checklist = compileChecklist(ctx, model);
  const mistakes = compileSection(ctx, model, "mistakes", column, 2) ?? compileSection(ctx, model, "mistakes", column, 1)!;
  // An ordinary note shares its band row with the psychology block; a long one
  // takes the full width so it wraps in half as many lines.
  const fullNote = compileNote(ctx, model, ctx.contentWidth);
  const beside = fullNote.lines.length <= 6;
  const psychology = compilePsychology(ctx, model, beside ? column : ctx.contentWidth);
  const note = beside ? compileNote(ctx, model, column) : fullNote;
  const extra = model.additionalFields.length ? compileAdditional(ctx, model) : null;
  return { left, right, checklist, mistakes, psychology, note, beside, extra };
}

function compileAdditional(ctx: Ctx, model: TradePresentation): Block {
  const metrics = ctx.metrics;
  const width = ctx.contentWidth;
  const cells = model.additionalFields.map(field => buildCell(ctx, field, width));
  const rows = cells.map(cell => ({ cells: [cell], height: cellHeight(cell, metrics) }));
  return { kind: "section", id: "additional", title: "Additional recorded fields", accent: PDF_COLORS.inkSoft, rows, height: metrics.sectionAdvance + rows.reduce((sum, row) => sum + row.height, 0) + 1.5 };
}

/** The full height of a trade data page: both columns, then every block below them. */
function tradePageHeight(ctx: Ctx, blocks: TradePageBlocks) {
  const columns = Math.max(
    blocks.left.reduce((sum, block) => sum + block.height, 0),
    blocks.right.reduce((sum, block) => sum + block.height, 0),
  );
  // The note needs at least its heading and two lines to be worth placing here.
  const noteReserve = blocks.beside
    ? Math.max(blocks.psychology.height, blocks.note.height)
    : blocks.psychology.height + ctx.metrics.sectionAdvance + ctx.metrics.labelLine + 2 * ctx.metrics.line + 4;
  return columns + 2 + Math.max(blocks.checklist.height, blocks.mistakes.height) + noteReserve + (blocks.extra?.height ?? 0);
}

function renderTradeDataPage(ctx: Ctx, model: TradePresentation, index: number, total: number) {
  const position = `Trade ${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
  const measurement = measureTradeDataPage(ctx.doc, model);
  const metrics = measurement.tier;
  startPage(ctx, {
    eyebrow: "GOLD JOURNAL · TRADE REPORT",
    title: position.toUpperCase(),
    continued: `${position.toUpperCase()} — TRADE DATA (CONTINUED)`,
    caption: model.identity.line,
    titleSize: metrics.title,
    metrics,
  });
  renderKpiStrip(ctx, model);

  const column = columnWidth(ctx);
  const blocks = tradePageBlocks(ctx, model, column);
  const columnsTop = ctx.y;
  // Left column, then right column: the reading order of the canonical sections.
  ctx.y = columnsTop;
  for (const block of blocks.left) renderBlock(ctx, block, PDF_PAGE.margin, column);
  const leftBottom = ctx.y;
  ctx.y = columnsTop;
  for (const block of blocks.right) renderBlock(ctx, block, PDF_PAGE.margin + column + metrics.gap, column);
  const rightBottom = ctx.y;

  // Checklist beside the recorded mistakes, matching the report's reading order.
  const bandTop = Math.max(leftBottom, rightBottom) + 2;
  ctx.y = bandTop;
  renderBlock(ctx, blocks.checklist, PDF_PAGE.margin, column);
  const checklistBottom = ctx.y;
  ctx.y = bandTop;
  renderBlock(ctx, blocks.mistakes, PDF_PAGE.margin + column + metrics.gap, column);
  ctx.y = Math.max(checklistBottom, ctx.y) + 2;

  const note = blocks.note;
  // Band 7-8: an ordinary journal note shares a band row with psychology, which is
  // the single biggest saving that keeps a populated trade on one page. A long
  // entry gets the full width and, if it still does not fit, a labelled
  // continuation page — never a truncation.
  const besideRowHeight = Math.max(blocks.psychology.height, note.height);
  const drawBeside = blocks.beside && ctx.y + besideRowHeight <= ctx.bottom;
  let noteDrawn = false;
  if (drawBeside) {
    const rowTop = ctx.y;
    renderBlock(ctx, blocks.psychology, PDF_PAGE.margin, column);
    const psychologyBottom = ctx.y;
    ctx.y = rowTop;
    renderBlock(ctx, note, PDF_PAGE.margin + column + metrics.gap, column);
    ctx.y = Math.max(psychologyBottom, ctx.y) + 2;
    noteDrawn = true;
  } else {
    renderBlock(ctx, blocks.psychology, PDF_PAGE.margin, ctx.contentWidth);
  }

  if (noteDrawn) {
    if (blocks.extra) renderBlock(ctx, blocks.extra, PDF_PAGE.margin, ctx.contentWidth);
    return;
  }

  // The full-width journal note: it uses the remaining space and continues onto a
  // labelled page only when the entry genuinely does not fit.
  if (ctx.y + note.height <= ctx.bottom) {
    renderBlock(ctx, note, PDF_PAGE.margin, ctx.contentWidth);
  } else {
    sectionBand(ctx, note.title, note.accent, PDF_PAGE.margin, ctx.contentWidth);
    const lines = ctx.doc.splitTextToSize(note.text, ctx.contentWidth - 6) as string[];
    const room = Math.max(1, Math.floor((ctx.bottom - ctx.y - metrics.labelLine - 4) / metrics.line));
    const firstPage = lines.slice(0, room);
    const rest = lines.slice(room);
    if (firstPage.length) {
      panel(ctx, PDF_PAGE.margin, ctx.y, ctx.contentWidth, metrics.labelLine + firstPage.length * metrics.line + 5, [252, 252, 251], PDF_COLORS.rule);
      ctx.doc.setFontSize(metrics.label);
      setText(ctx.doc, PDF_COLORS.inkSoft);
      ctx.doc.text(note.label.toUpperCase(), PDF_PAGE.margin + 3, ctx.y + 3.6);
      ctx.doc.setFontSize(metrics.body);
      setText(ctx.doc, PDF_COLORS.ink);
      firstPage.forEach((line, lineIndex) => ctx.doc.text(line, PDF_PAGE.margin + 3, ctx.y + 3.6 + metrics.labelLine + lineIndex * metrics.line));
    }
    if (rest.length) {
      nextPage(ctx);
      sectionBand(ctx, `${note.title} (continued)`, note.accent, PDF_PAGE.margin, ctx.contentWidth);
      // The continuation may itself span pages, so the text style is re-applied
      // for every line rather than once before the loop.
      rest.forEach(line => {
        ensureSpace(ctx, metrics.line);
        ctx.doc.setFontSize(metrics.body);
        setText(ctx.doc, PDF_COLORS.ink);
        ctx.doc.text(line, PDF_PAGE.margin, ctx.y);
        ctx.y += ctx.metrics.line;
      });
    }
  }

  if (blocks.extra) renderBlock(ctx, blocks.extra, PDF_PAGE.margin, ctx.contentWidth);
}

/* ------------------------------------------------------------------ *
 * Analysis pages
 * ------------------------------------------------------------------ */

function metricGrid(ctx: Ctx, items: { label: string; value: string; tone?: TradeTone }[], columns = METRIC_COLUMNS) {
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
      return { item, inline, lines: lines.length ? lines : [PRESENTATION_MISSING] };
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

/** The analysis headline cards: larger figures, one tinted card per metric. */
function renderKpiCards(ctx: Ctx, items: { label: string; value: string; tone?: TradeTone }[]) {
  const metrics = ctx.metrics;
  const count = Math.max(1, Math.min(items.length, KPI_COLUMNS));
  const gap = 2;
  const width = (ctx.contentWidth - gap * (count - 1)) / count;
  const height = 19;
  ensureSpace(ctx, height + 4);
  items.slice(0, KPI_COLUMNS).forEach((item, index) => {
    const x = PDF_PAGE.margin + index * (width + gap);
    panel(ctx, x, ctx.y, width, height, toneTint(item.tone, item.value), PDF_COLORS.panelLine);
    ctx.doc.setFontSize(PDF_MIN_FONT);
    setText(ctx.doc, PDF_COLORS.inkSoft);
    ctx.doc.text(item.label.toUpperCase(), x + 3.2, ctx.y + 6);
    ctx.doc.setFontSize(13);
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "bold");
    setText(ctx.doc, toneColor(item.tone, item.value));
    ctx.doc.text(ctx.doc.splitTextToSize(item.value, width - 7)[0] ?? PRESENTATION_MISSING, x + 3.2, ctx.y + 14.6);
    if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "normal");
  });
  ctx.doc.setFontSize(metrics.body);
  ctx.y += height + 5;
}

function tableColumnWidths(table: AnalysisTable, width: number) {
  const total = table.columns.reduce((sum, column) => sum + column.flex, 0) || 1;
  return table.columns.map(column => (width * column.flex) / total);
}

/** The vertical space a table's title, coloured header band, and first row need. */
const TABLE_HEADER_BLOCK = 2.8 + 5.2;

/**
 * The exact height `renderTable` will consume, so a pair of tables only moves to
 * another page when it genuinely does not fit.
 */
function measureTable(ctx: Ctx, table: AnalysisTable, width: number) {
  const doc = ctx.doc;
  const perCell = tableColumnWidths(table, width);
  doc.setFontSize(TABLE_FONT.body);
  const rows = table.rows.map(row => {
    const lines = Math.max(1, ...row.map((value, index) => doc.splitTextToSize(String(value), Math.max(4, perCell[index] - 3)).length));
    return lines * TABLE_FONT.line + TABLE_FONT.padding;
  });
  const empty = table.rows.length ? 0 : TABLE_FONT.line * 2;
  return TABLE_HEADER_BLOCK + rows.reduce((sum, height) => sum + height, 0) + empty;
}

/** Draws a table with a tinted header band, repeating it after a page break. */
function renderTable(ctx: Ctx, table: AnalysisTable, width: number, x: number = PDF_PAGE.margin, accent: Rgb = PDF_HEADER_COLOR) {
  const doc = ctx.doc;
  const perCell = tableColumnWidths(table, width);
  const drawHeader = () => {
    doc.setFontSize(TABLE_FONT.title);
    if (doc.setFont) doc.setFont("helvetica", "bold");
    setText(doc, PDF_COLORS.ink);
    doc.text(table.title.toUpperCase(), x, ctx.y);
    if (doc.setFont) doc.setFont("helvetica", "normal");
    ctx.y += 2.8;
    panel(ctx, x, ctx.y, width, 5, accent, accent);
    doc.setFontSize(TABLE_FONT.header);
    setText(doc, PDF_COLORS.onAccent);
    let cursor = x;
    table.columns.forEach((column, index) => {
      doc.text(column.label.toUpperCase(), column.align === "right" ? cursor + perCell[index] - 2 : cursor + 2, ctx.y + 3.6, column.align === "right" ? { align: "right" } : undefined);
      cursor += perCell[index];
    });
    ctx.y += TABLE_FONT.line + 1.8;
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
      const lines = doc.splitTextToSize(String(value), Math.max(4, perCell[index] - 3)) as string[];
      return lines.length ? lines : [PRESENTATION_MISSING];
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
        doc.text(line, isNumeric ? cursor + perCell[index] - 2 : cursor + 2, ctx.y + lineIndex * TABLE_FONT.line, isNumeric ? { align: "right" } : undefined);
      });
      cursor += perCell[index];
    });
    ctx.y += height;
    if (rowIndex < table.rows.length - 1) hairline(ctx, ctx.y - TABLE_FONT.padding + 0.3, x, width, PDF_COLORS.panelLine, 0.15);
  });
  ctx.y += 2.6;
}

function renderAnalysisBlock(ctx: Ctx, block: AnalysisBlock) {
  if (block.kind === "heading") { sectionBand(ctx, block.title, PDF_HEADER_COLOR, PDF_PAGE.margin, ctx.contentWidth); return; }
  // The cards are self-labelling, so the KPI band needs no heading; every metric
  // grid does, otherwise its title would be silently dropped from the page.
  if (block.kind === "kpis") { renderKpiCards(ctx, block.items); return; }
  if (block.kind === "metrics") {
    if (block.title) sectionBand(ctx, block.title, PDF_COLORS.accentAlt, PDF_PAGE.margin, ctx.contentWidth);
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
  if (block.title) sectionBand(ctx, block.title, PDF_SECTION_COLORS.psychology, PDF_PAGE.margin, ctx.contentWidth);
  if (block.flow) {
    writeWrapped(ctx, block.lines.join(" · "), { color: PDF_COLORS.inkSoft, lineHeight: 3.5, fontSize: ANALYSIS_METRICS.body });
    return;
  }
  for (const line of block.lines) {
    ensureSpace(ctx, 3.6);
    ctx.doc.setFontSize(ANALYSIS_METRICS.body);
    setText(ctx.doc, PDF_HEADER_COLOR);
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
  if (block.title) sectionBand(ctx, block.title, PDF_SECTION_COLORS.psychology, x, width);
  if (block.flow) {
    writeWrapped(ctx, block.lines.join(" · "), { x, maxWidth: width, color: PDF_COLORS.inkSoft, lineHeight: 3.5, fontSize: ANALYSIS_METRICS.body });
    ctx.y += 3;
    return;
  }
  for (const line of block.lines) {
    ensureSpace(ctx, 3.6);
    ctx.doc.setFontSize(ANALYSIS_METRICS.body);
    setText(ctx.doc, PDF_HEADER_COLOR);
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
    doc.setFontSize(PDF_MIN_FONT);
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
 * Renders the whole report: two pages per trade (a complete data table, then its
 * screenshot evidence), the analysis pages, and a footer on every page — all from
 * the same exported trade set, with one screenshot fetch per unique URL.
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
    const model = buildTradePresentation(row.trade, { runningBalance: row.runningBalance ?? null });
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
