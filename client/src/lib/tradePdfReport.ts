/**
 * The PDF report: two pages per trade (complete data, then screenshot evidence), one
 * page per analysis question (performance, process, psychology, review), and a
 * footer on every page.
 *
 * Every value comes from `buildTradePresentation` (the canonical model the Trade Card
 * and the share image render) and `buildPeriodAnalysis`; no MT5 ticket, screenshot
 * file name, storage detail, image format, or internal id is ever drawn. Geometry,
 * the vertical cursor, and the primitives live in `./tradePdfLayout`.
 */

import {
  ANALYSIS_METRICS,
  HEADER_HEIGHT,
  KPI_COLUMNS,
  KPI_STRIP_HEIGHT,
  METRIC_COLUMNS,
  PDF_COLORS,
  PDF_HEADER_COLOR,
  PDF_MIN_FONT,
  PDF_PAGE,
  PDF_SECTION_COLORS,
  SCREENSHOT_CAPTION,
  SECTION_GAP,
  TABLE_FONT,
  TRADE_METRICS,
  ascent,
  compactListValue,
  contentBottom,
  contentWidth,
  descent,
  drawLines,
  ensureSpace,
  findLayoutOverlaps,
  hairline,
  nextPage,
  paintBand,
  panel,
  renderSection,
  reserveBlock,
  sectionBandOnly,
  setDraw,
  setText,
  startPage,
  toneColor,
  toneTint,
  wrapText,
  writeWrapped,
  type Ctx,
  type Metrics,
  type PdfDoc,
  type PdfImage,
  type PdfLayoutBlock,
  type PdfTextOptions,
  type Rgb,
} from "./tradePdfLayout";
import {
  PRESENTATION_MISSING,
  TRADE_SECTION_THEME,
  buildTradePresentation,
  type TradePresentation,
  type TradePresentationChecklistItem,
  type TradePresentationField,
  type TradePresentationSectionId,
  type TradeTone,
} from "./tradePresentation";
import { buildPeriodAnalysis, type AnalysisBlock, type AnalysisPage, type AnalysisTable, type PeriodAnalysis } from "./tradePdfAnalysis";
import type { BulkPdfSummary } from "./bulkPdf";

/** The page geometry, palette, and layout primitives are the report's public surface. */
export * from "./tradePdfLayout";

/** Shown when a screenshot was recorded but could not be embedded. */
export const SCREENSHOT_EMBED_FAILURE = "The screenshot could not be loaded for this export.";

/** The trailing space one trade-page block leaves before the next one starts. */
const BLOCK_TRAILING = 0.8;
/** Vertical space between the trade page's block rows. */
const ROW_GAP = 1.2;

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

/** A trade-page block: a coloured band plus the measured content beneath it. */
type Block =
  | { kind: "section"; id: string; title: string; accent: Rgb; rows: Array<{ cells: Cell[]; height: number }>; height: number }
  | { kind: "checklist"; id: "checklist"; title: string; accent: Rgb; columns: TradePresentationChecklistItem[][]; rowHeight: number; height: number }
  | { kind: "process"; id: "process"; title: string; accent: Rgb; label: string; summaryLines: string[]; reviewLines: string[]; tone: TradeTone; panelHeight: number; summaryTop: number; reviewTop: number; reviewLinesTop: number; height: number }
  | { kind: "psychology"; id: "psychology"; title: string; accent: Rgb; cells: Array<{ label: string; lines: string[] }>; boxHeight: number; linesTop: number; height: number }
  | { kind: "note"; id: "journal"; title: string; accent: Rgb; label: string; text: string; lines: string[]; boxHeight: number; textTop: number; height: number };

function columnWidth(ctx: Ctx) { return (ctx.contentWidth - ctx.metrics.gap) / 2; }

/** Measures one field cell at the width it will actually occupy. */
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

/**
 * The exact height of one field cell: its label lines (when the cell stacks), then
 * its value lines, each expressed as `ascent + (lines - 1) * line + descent`.
 */
function cellHeight(cell: Cell, metrics: Metrics) {
  const labelBlock = cell.stacked ? cell.labelLines.length * metrics.labelLine : Math.max(ascent(metrics.label), ascent(metrics.body));
  return labelBlock + ascent(metrics.body) + Math.max(0, cell.lines.length - 1) * metrics.line + descent(metrics.body) + metrics.rowGap;
}

/** A coloured section band, then rows of up to `columns` measured field cells. */
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
  return { kind: "section", id, title: section.title, accent: PDF_SECTION_COLORS[id], rows, height: metrics.sectionAdvance + SECTION_GAP + rows.reduce((sum, row) => sum + row.height, 0) + BLOCK_TRAILING };
}

/** The checklist as two columns of confirmed / not-confirmed items. */
function compileChecklist(ctx: Ctx, model: TradePresentation): Block {
  const metrics = ctx.metrics;
  const half = Math.ceil(model.checklist.length / 2);
  const columns = [model.checklist.slice(0, half), model.checklist.slice(half)];
  const rowHeight = Math.max(metrics.line, ascent(metrics.body) + descent(metrics.body) + 0.6) + 0.15;
  const height = metrics.sectionAdvance + SECTION_GAP + Math.max(...columns.map(column => column.length)) * rowHeight + BLOCK_TRAILING;
  return { kind: "checklist", id: "checklist", title: TRADE_SECTION_THEME.checklist.title, accent: PDF_SECTION_COLORS.checklist, columns, rowHeight, height };
}

/** The process verdict, shown as its own tinted panel so P&L never implies process. */
function compileProcess(ctx: Ctx, model: TradePresentation, width: number): Block {
  const metrics = ctx.metrics;
  ctx.doc.setFontSize(metrics.body);
  const summaryLines = (ctx.doc.splitTextToSize(model.classification.summary, width - 8) as string[]).slice(0, 2);
  const review = model.sections.find(section => section.id === "discipline")?.fields.find(field => field.key === "processReview")?.value ?? PRESENTATION_MISSING;
  const reviewLines = (ctx.doc.splitTextToSize(review, width - 4) as string[]).slice(0, 3);
  // Band, then the classification panel (label + summary), then the process-review
  // caption and its lines. Each offset is measured once and reused when drawing.
  const summaryTop = 3.4 + descent(10) + 2;
  const panelHeight = summaryTop + Math.max(0, summaryLines.length - 1) * metrics.line + descent(metrics.body) + 1;
  const reviewTop = panelHeight + 2.6 + ascent(metrics.label);
  const reviewLinesTop = reviewTop + descent(metrics.label) + 0.8 + ascent(metrics.body);
  const contentHeight = reviewLinesTop + Math.max(0, reviewLines.length - 1) * metrics.line + descent(metrics.body) + BLOCK_TRAILING;
  return {
    kind: "process",
    id: "process",
    title: "Process",
    accent: PDF_SECTION_COLORS.discipline,
    label: model.classification.label,
    summaryLines,
    reviewLines,
    tone: model.classification.tone,
    panelHeight,
    summaryTop,
    reviewTop,
    reviewLinesTop,
    height: metrics.sectionAdvance + SECTION_GAP + contentHeight,
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
  const rows = Math.max(1, ...cells.map(cell => cell.lines.length));
  const linesTop = 3.2 + descent(metrics.label) + 2;
  const boxHeight = linesTop + (rows - 1) * metrics.line + descent(metrics.body) + 1.1;
  return { kind: "psychology", id: "psychology", title: TRADE_SECTION_THEME.psychology.title, accent: PDF_SECTION_COLORS.psychology, cells, boxHeight, linesTop, height: metrics.sectionAdvance + SECTION_GAP + boxHeight + BLOCK_TRAILING };
}

/** The journal note, measured in the exact box it will occupy. */
function compileNote(ctx: Ctx, model: TradePresentation, width: number): Extract<Block, { kind: "note" }> {
  const metrics = ctx.metrics;
  const label = model.sections.find(section => section.id === "journal")?.fields[0]?.label ?? TRADE_SECTION_THEME.journal.title;
  ctx.doc.setFontSize(metrics.body);
  const value = model.journalNotes.trim() === "" ? PRESENTATION_MISSING : model.journalNotes;
  const lines = ctx.doc.splitTextToSize(value, width - 6) as string[];
  const textTop = 3.2 + descent(metrics.label) + 2.2;
  const boxHeight = textTop + Math.max(0, lines.length - 1) * metrics.line + descent(metrics.body) + 1.2;
  return { kind: "note", id: "journal", title: TRADE_SECTION_THEME.journal.title, accent: PDF_SECTION_COLORS.journal, label, text: value, lines, boxHeight, textTop, height: metrics.sectionAdvance + SECTION_GAP + boxHeight + BLOCK_TRAILING };
}

/** Draws one trade-page block inside the box measured for it; the cursor never moves. */
function renderBlock(ctx: Ctx, block: Block, x: number, width: number) {
  const metrics = ctx.metrics;
  const doc = ctx.doc;
  renderSection(ctx, `${block.kind}:${block.id}`, block.title, block.accent, x, width, block.height, contentTop => {
    if (block.kind === "section") {
      let rowTop = contentTop;
      block.rows.forEach((row, rowIndex) => {
        // A row with fewer cells than the section's grid is wider than measured; the
        // pre-wrapped lines are redrawn as they are, so the row height still holds.
        const cellWidth = row.cells.length === 1 ? width : (width - metrics.gap * (row.cells.length - 1)) / row.cells.length;
        let cursor = x;
        for (const cell of row.cells) {
          // The first baseline sits one ascender below the top of its line box, so a
          // label or value can never reach up into the band or the row above.
          const labelTop = rowTop + ascent(metrics.label);
          doc.setFontSize(metrics.label);
          setText(doc, PDF_COLORS.inkSoft);
          cell.labelLines.forEach((line, index) => doc.text(line, cursor, labelTop + index * metrics.labelLine));
          const valueTop = cell.stacked ? rowTop + cell.labelLines.length * metrics.labelLine : rowTop;
          doc.setFontSize(metrics.body);
          setText(doc, toneColor(cell.tone, cell.value));
          const valueX = cell.stacked ? cursor : cursor + cellWidth * 0.44;
          cell.lines.forEach((line, index) => doc.text(line, valueX, valueTop + ascent(metrics.body) + index * metrics.line));
          cursor += cellWidth + metrics.gap;
        }
        rowTop += row.height;
        if (rowIndex < block.rows.length - 1) hairline(ctx, rowTop - metrics.rowGap + 0.2, x, width, PDF_COLORS.panelLine, 0.15);
      });
      return;
    }

    if (block.kind === "checklist") {
      const half = (width - metrics.gap) / 2;
      const baseline = contentTop + ascent(metrics.body);
      block.columns.forEach((items, columnIndex) => {
        items.forEach((item, index) => {
          const lineY = baseline + index * block.rowHeight;
          const mark = item.confirmed ? "✓" : "✗";
          doc.setFontSize(metrics.body);
          setText(doc, item.confirmed ? PDF_COLORS.positive : item.recorded ? PDF_COLORS.negative : PDF_COLORS.inkFaint);
          doc.text(mark, x + columnIndex * (half + metrics.gap), lineY);
          setText(doc, item.confirmed ? PDF_COLORS.ink : PDF_COLORS.inkSoft);
          doc.text(doc.splitTextToSize(item.label, half - 5)[0] ?? item.label, x + columnIndex * (half + metrics.gap) + 4, lineY);
        });
      });
      return;
    }

    if (block.kind === "process") {
      const fill = toneTint(block.tone);
      panel(ctx, x, contentTop, width, block.panelHeight, fill, PDF_COLORS.panelLine);
      doc.setFontSize(10);
      if (doc.setFont) doc.setFont("helvetica", "bold");
      setText(doc, toneColor(block.tone));
      doc.text(block.label.toUpperCase(), x + 3.4, contentTop + ascent(10));
      if (doc.setFont) doc.setFont("helvetica", "normal");
      doc.setFontSize(metrics.body);
      setText(doc, PDF_COLORS.inkSoft);
      block.summaryLines.forEach((line, index) => doc.text(line, x + 3.4, contentTop + block.summaryTop + index * metrics.line));
      doc.setFontSize(metrics.label);
      setText(doc, PDF_COLORS.inkSoft);
      doc.text("PROCESS REVIEW", x, contentTop + block.reviewTop);
      doc.setFontSize(metrics.body);
      setText(doc, PDF_COLORS.ink);
      block.reviewLines.forEach((line, index) => doc.text(line, x, contentTop + block.reviewLinesTop + index * metrics.line));
      return;
    }

    if (block.kind === "psychology") {
      const cellWidth = (width - metrics.gap * 2) / 3;
      block.cells.forEach((cell, index) => {
        const cellX = x + index * (cellWidth + metrics.gap);
        panel(ctx, cellX, contentTop, cellWidth, block.boxHeight, PDF_COLORS.panel, PDF_COLORS.panelLine);
        doc.setFontSize(metrics.label);
        setText(doc, PDF_COLORS.inkSoft);
        doc.text(cell.label.toUpperCase(), cellX + 2.6, contentTop + 3.2);
        doc.setFontSize(metrics.body);
        setText(doc, PDF_COLORS.ink);
        cell.lines.forEach((line, lineIndex) => doc.text(line, cellX + 2.6, contentTop + block.linesTop + lineIndex * metrics.line));
      });
      return;
    }

    // note: a bordered text box so the journal entry reads as one passage.
    panel(ctx, x, contentTop, width, block.boxHeight, [252, 252, 251], PDF_COLORS.rule);
    doc.setFontSize(metrics.label);
    setText(doc, PDF_COLORS.inkSoft);
    doc.text(block.label.toUpperCase(), x + 3, contentTop + 3.2);
    doc.setFontSize(metrics.body);
    setText(doc, PDF_COLORS.ink);
    block.lines.forEach((line, index) => doc.text(line, x + 3, contentTop + block.textTop + index * metrics.line));
  });
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

/** Measures the trade data page at every typography tier; the first tier that fits wins. */
export function measureTradeDataPage(doc: PdfDoc, model: TradePresentation) {
  const available = contentBottom() - (PDF_PAGE.margin + HEADER_HEIGHT) - KPI_STRIP_HEIGHT - 4;
  const ctx: Ctx = {
    doc, started: false, y: 0, bodyTop: 0, bottom: contentBottom(), contentWidth: contentWidth(),
    metrics: TRADE_METRICS[1], header: { eyebrow: "", title: "", continued: "" }, titleSize: 16, page: 1, blocks: [],
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
  return { kind: "section", id: "additional", title: "Additional recorded fields", accent: PDF_COLORS.inkSoft, rows, height: metrics.sectionAdvance + SECTION_GAP + rows.reduce((sum, row) => sum + row.height, 0) + BLOCK_TRAILING };
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
  const bandTop = Math.max(leftBottom, rightBottom) + ROW_GAP;
  ctx.y = bandTop;
  renderBlock(ctx, blocks.checklist, PDF_PAGE.margin, column);
  const checklistBottom = ctx.y;
  ctx.y = bandTop;
  renderBlock(ctx, blocks.mistakes, PDF_PAGE.margin + column + metrics.gap, column);
  ctx.y = Math.max(checklistBottom, ctx.y) + ROW_GAP;

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
    ctx.y = Math.max(psychologyBottom, ctx.y) + ROW_GAP;
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
    const lines = ctx.doc.splitTextToSize(note.text, ctx.contentWidth - 6) as string[];
    // Band, gap, then the first box: the same arithmetic the block renderer uses,
    // so the box and its label sit below the band exactly as a normal note does.
    const bandHeight = metrics.sectionAdvance;
    const boxTop = 3.2 + descent(metrics.label) + 2.6;
    ensureSpace(ctx, bandHeight + SECTION_GAP + boxTop + metrics.line);
    const top = ctx.y;
    paintBand(ctx, note.title, note.accent, PDF_PAGE.margin, top, ctx.contentWidth, bandHeight);
    ctx.blocks.push({ id: `band:${note.title.toUpperCase()}`, page: ctx.page, x: PDF_PAGE.margin, y: top, width: ctx.contentWidth, height: bandHeight, kind: "band", title: note.title.toUpperCase() });
    const contentTop = top + bandHeight + SECTION_GAP;
    const room = Math.max(1, Math.floor((ctx.bottom - contentTop - boxTop - descent(metrics.body)) / metrics.line));
    const firstPage = lines.slice(0, room);
    const rest = lines.slice(room);
    const boxHeight = boxTop + Math.max(0, firstPage.length - 1) * metrics.line + descent(metrics.body) + 1.8;
    panel(ctx, PDF_PAGE.margin, contentTop, ctx.contentWidth, boxHeight, [252, 252, 251], PDF_COLORS.rule);
    ctx.doc.setFontSize(metrics.label);
    setText(ctx.doc, PDF_COLORS.inkSoft);
    ctx.doc.text(note.label.toUpperCase(), PDF_PAGE.margin + 3, contentTop + 3.2);
    ctx.doc.setFontSize(metrics.body);
    setText(ctx.doc, PDF_COLORS.ink);
    firstPage.forEach((line, lineIndex) => ctx.doc.text(line, PDF_PAGE.margin + 3, contentTop + boxTop + lineIndex * metrics.line));
    ctx.blocks.push({ id: `note:${note.id}.content`, page: ctx.page, x: PDF_PAGE.margin, y: contentTop, width: ctx.contentWidth, height: boxHeight, kind: "text" });
    ctx.y = contentTop + boxHeight;
    if (rest.length) {
      nextPage(ctx);
      const continuationTop = ctx.y;
      paintBand(ctx, `${note.title} (continued)`, note.accent, PDF_PAGE.margin, continuationTop, ctx.contentWidth, bandHeight);
      ctx.blocks.push({ id: `band:${note.title.toUpperCase()} (continued)`, page: ctx.page, x: PDF_PAGE.margin, y: continuationTop, width: ctx.contentWidth, height: bandHeight, kind: "band", title: `${note.title.toUpperCase()} (CONTINUED)` });
      ctx.y = continuationTop + bandHeight + SECTION_GAP;
      // The continuation may itself span pages, so it paginates line by line and
      // registers one measured block per page it reaches.
      drawLines(ctx, `note:${note.id}.continued`, rest, PDF_PAGE.margin, { lineHeight: metrics.line, fontSize: metrics.body });
    }
  }

  if (blocks.extra) renderBlock(ctx, blocks.extra, PDF_PAGE.margin, ctx.contentWidth);
}

/* ------------------------------------------------------------------ *
 * Analysis pages
 * ------------------------------------------------------------------ */

type MetricGridItem = { label: string; value: string; tone?: TradeTone };
type MetricGridCell = { item: MetricGridItem; stacked: boolean; labelLines: string[]; lines: string[]; height: number };
type MetricGridRow = { cells: MetricGridCell[]; height: number };

/** Measures a metric grid before drawing it, so its heading and grid are reserved together. */
function measureMetricGrid(ctx: Ctx, items: MetricGridItem[], columns: number = METRIC_COLUMNS): MetricGridRow[] {
  const metrics = ctx.metrics;
  const doc = ctx.doc;
  const width = (ctx.contentWidth - metrics.gap * (columns - 1)) / columns;
  const labelWidth = width * 0.5;
  const rows: MetricGridRow[] = [];
  for (let index = 0; index < items.length; index += columns) {
    const slice = items.slice(index, index + columns);
    doc.setFontSize(metrics.label);
    const cells: MetricGridCell[] = slice.map(item => {
      const labelLines = doc.splitTextToSize(item.label.toUpperCase(), labelWidth - 1) as string[];
      // A label too long for its half of the cell stacks above the value, so the
      // two never share a line and never collide with the neighbouring metric.
      const stacked = labelLines.length > 1;
      doc.setFontSize(metrics.body);
      const valueLines = doc.splitTextToSize(item.value, Math.max(8, stacked ? width : width - labelWidth - 2)) as string[];
      const lines = valueLines.length ? valueLines : [PRESENTATION_MISSING];
      const labelBlock = stacked ? labelLines.length * metrics.labelLine : Math.max(ascent(metrics.label), ascent(metrics.body));
      const height = labelBlock + ascent(metrics.body) + Math.max(0, lines.length - 1) * metrics.line + descent(metrics.body);
      return { item, stacked, labelLines, lines, height };
    });
    rows.push({ cells, height: Math.max(...cells.map(cell => cell.height)) + metrics.rowGap });
  }
  return rows;
}

function metricGridHeight(rows: MetricGridRow[]) { return rows.reduce((sum, row) => sum + row.height, 0); }

/** Draws a measured grid inside the box that was reserved for it. */
function drawMetricGrid(ctx: Ctx, rows: MetricGridRow[], top: number, columns: number = METRIC_COLUMNS) {
  const metrics = ctx.metrics;
  const doc = ctx.doc;
  const width = (ctx.contentWidth - metrics.gap * (columns - 1)) / columns;
  const labelWidth = width * 0.5;
  let rowTop = top;
  for (const row of rows) {
    row.cells.forEach((cell, cellIndex) => {
      const x = PDF_PAGE.margin + cellIndex * (width + metrics.gap);
      doc.setFontSize(metrics.label);
      setText(doc, PDF_COLORS.inkSoft);
      cell.labelLines.forEach((line, lineIndex) => doc.text(line, x, rowTop + ascent(metrics.label) + lineIndex * metrics.labelLine));
      doc.setFontSize(metrics.body);
      setText(doc, toneColor(cell.item.tone, cell.item.value));
      const valueTop = cell.stacked ? rowTop + cell.labelLines.length * metrics.labelLine : rowTop;
      cell.lines.forEach((line, lineIndex) => doc.text(line, cell.stacked ? x : x + labelWidth, valueTop + ascent(metrics.body) + lineIndex * metrics.line));
    });
    rowTop += row.height;
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

/** The coloured column-header band of a table, and the clear space after it. */
const TABLE_HEADER_HEIGHT = 5;
const TABLE_HEADER_GAP = 2.4;

/** The table's title, its column-header band, and the gap before the first row. */
function tableHeaderHeight() {
  return ascent(TABLE_FONT.title) + descent(TABLE_FONT.title) + 1.4 + TABLE_HEADER_HEIGHT + TABLE_HEADER_GAP;
}

/**
 * One table row: the ascender of its first line, the remaining wrapped lines, and
 * the descender plus padding of its last — so a two-line cell grows its own row
 * instead of printing over the row beneath it.
 */
function tableRowHeight(lines: number) {
  return ascent(TABLE_FONT.body) + Math.max(0, lines - 1) * TABLE_FONT.line + descent(TABLE_FONT.body) + TABLE_FONT.padding;
}

/**
 * The exact height `renderTable` will consume, so a pair of tables only moves to
 * another page when it genuinely does not fit.
 */
function measureTable(ctx: Ctx, table: AnalysisTable, width: number) {
  const doc = ctx.doc;
  const perCell = tableColumnWidths(table, width);
  doc.setFontSize(TABLE_FONT.body);
  if (!table.rows.length) return tableHeaderHeight() + tableRowHeight(1) + TABLE_FONT.line + 2.6;
  const rows = table.rows.map(row => {
    const lines = Math.max(1, ...row.map((value, index) => doc.splitTextToSize(String(value), Math.max(4, perCell[index] - 3)).length));
    return tableRowHeight(lines);
  });
  return tableHeaderHeight() + rows.reduce((sum, height) => sum + height, 0) + 2.6;
}

/** Draws a table, repeating its measured header band after each page break. */
function renderTable(ctx: Ctx, table: AnalysisTable, width: number, x: number = PDF_PAGE.margin, accent: Rgb = PDF_HEADER_COLOR) {
  const doc = ctx.doc;
  const perCell = tableColumnWidths(table, width);
  // Each page the table reaches registers one measured block, so a table that
  // continues onto the next page is validated on both pages.
  let segmentTop = 0;
  let segmentPage = 0;
  const openSegment = () => { segmentTop = ctx.y; segmentPage = ctx.page; };
  const closeSegment = () => {
    if (ctx.y - segmentTop > 0.2) ctx.blocks.push({ id: `table:${table.title}`, page: segmentPage, x, y: segmentTop, width, height: ctx.y - segmentTop, kind: "table" });
  };
  const drawHeader = () => {
    doc.setFontSize(TABLE_FONT.title);
    if (doc.setFont) doc.setFont("helvetica", "bold");
    setText(doc, PDF_COLORS.ink);
    doc.text(table.title.toUpperCase(), x, ctx.y + ascent(TABLE_FONT.title));
    if (doc.setFont) doc.setFont("helvetica", "normal");
    const bandTop = ctx.y + ascent(TABLE_FONT.title) + descent(TABLE_FONT.title) + 1.4;
    panel(ctx, x, bandTop, width, TABLE_HEADER_HEIGHT, accent, accent);
    doc.setFontSize(TABLE_FONT.header);
    setText(doc, PDF_COLORS.onAccent);
    let cursor = x;
    table.columns.forEach((column, index) => {
      doc.text(column.label.toUpperCase(), column.align === "right" ? cursor + perCell[index] - 2 : cursor + 2, bandTop + 3.4, column.align === "right" ? { align: "right" } : undefined);
      cursor += perCell[index];
    });
    ctx.y = bandTop + TABLE_HEADER_HEIGHT + TABLE_HEADER_GAP;
  };
  ensureSpace(ctx, tableHeaderHeight() + tableRowHeight(1));
  openSegment();
  drawHeader();
  if (!table.rows.length) {
    doc.setFontSize(TABLE_FONT.body);
    setText(doc, PDF_COLORS.inkFaint);
    doc.text(table.empty, x, ctx.y + ascent(TABLE_FONT.body));
    ctx.y += tableRowHeight(1) + TABLE_FONT.line;
    closeSegment();
    ctx.y += 2.6;
    return;
  }
  table.rows.forEach((row, rowIndex) => {
    doc.setFontSize(TABLE_FONT.body);
    const wrapped: string[][] = row.map((value: string, index: number) => {
      const lines = doc.splitTextToSize(String(value), Math.max(4, perCell[index] - 3)) as string[];
      return lines.length ? lines : [PRESENTATION_MISSING];
    });
    const height = tableRowHeight(Math.max(...wrapped.map(lines => lines.length)));
    if (ctx.y + height > ctx.bottom) {
      closeSegment();
      nextPage(ctx);
      openSegment();
      drawHeader();
      doc.setFontSize(TABLE_FONT.body);
    }
    let cursor = x;
    wrapped.forEach((lines: string[], index: number) => {
      const column = table.columns[index];
      const isNumeric = column.align === "right";
      setText(doc, isNumeric ? toneColor("signed", lines[0]) : PDF_COLORS.ink);
      lines.forEach((line: string, lineIndex: number) => {
        doc.text(line, isNumeric ? cursor + perCell[index] - 2 : cursor + 2, ctx.y + ascent(TABLE_FONT.body) + lineIndex * TABLE_FONT.line, isNumeric ? { align: "right" } : undefined);
      });
      cursor += perCell[index];
    });
    ctx.y += height;
    if (rowIndex < table.rows.length - 1) hairline(ctx, ctx.y - TABLE_FONT.padding + 0.3, x, width, PDF_COLORS.panelLine, 0.15);
  });
  closeSegment();
  ctx.y += 2.6;
}

function renderAnalysisBlock(ctx: Ctx, block: AnalysisBlock) {
  if (block.kind === "heading") { sectionBandOnly(ctx, `heading:${block.title}`, block.title, PDF_HEADER_COLOR, PDF_PAGE.margin, ctx.contentWidth); return; }
  // The cards are self-labelling, so the KPI band needs no heading; every metric
  // grid does, otherwise its title would be silently dropped from the page.
  if (block.kind === "kpis") { renderKpiCards(ctx, block.items); return; }
  if (block.kind === "metrics") {
    const rows = measureMetricGrid(ctx, block.items);
    if (!rows.length) return;
    const content = metricGridHeight(rows);
    if (!block.title) {
      const top = reserveBlock(ctx, { id: `metrics:${block.items[0].label}`, kind: "text", x: PDF_PAGE.margin, width: ctx.contentWidth, height: content });
      drawMetricGrid(ctx, rows, top);
      return;
    }
    // The heading and the grid are reserved together, so the heading can never be
    // drawn over the first row of the metrics it introduces.
    renderSection(ctx, `metrics:${block.title}`, block.title, PDF_COLORS.accentAlt, PDF_PAGE.margin, ctx.contentWidth, ctx.metrics.sectionAdvance + SECTION_GAP + content + 1.5, contentTop => drawMetricGrid(ctx, rows, contentTop));
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
  renderParagraphBlock(ctx, block, PDF_PAGE.margin, ctx.contentWidth);
}

type ParagraphBlock = Extract<AnalysisBlock, { kind: "paragraph" }>;

/** The exact height a bullet block occupies at a given width, so columns can balance. */
function paragraphHeight(ctx: Ctx, block: ParagraphBlock, width: number) {
  const metrics = ANALYSIS_METRICS;
  const doc = ctx.doc;
  doc.setFontSize(metrics.body);
  let height = block.title ? metrics.sectionAdvance + SECTION_GAP : 0;
  if (block.flow) {
    const lines = wrapText(doc, block.lines.join(" · "), width);
    return height + ascent(metrics.body) + Math.max(0, lines.length - 1) * 3.5 + descent(metrics.body) + 3;
  }
  for (const line of block.lines) {
    const wrapped = wrapText(doc, line, width - 4);
    height += ascent(metrics.body) + Math.max(0, wrapped.length - 1) * 3.6 + descent(metrics.body) + 0.9;
  }
  return height + 2;
}

/** Draws one bullet (or flow) block inside the box measured for it. */
function renderParagraphBlock(ctx: Ctx, block: ParagraphBlock, x: number, width: number) {
  const metrics = ANALYSIS_METRICS;
  const doc = ctx.doc;
  const total = paragraphHeight(ctx, block, width);
  const body = (contentTop: number) => {
    if (block.flow) {
      const lines = wrapText(doc, block.lines.join(" · "), width);
      lines.forEach((line, index) => {
        doc.setFontSize(metrics.body);
        setText(doc, PDF_COLORS.inkSoft);
        doc.text(line, x, contentTop + ascent(metrics.body) + index * 3.5);
      });
      return;
    }
    let lineTop = contentTop;
    for (const line of block.lines) {
      const wrapped = wrapText(doc, line, width - 4);
      doc.setFontSize(metrics.body);
      setText(doc, PDF_HEADER_COLOR);
      doc.text("•", x, lineTop + ascent(metrics.body));
      setText(doc, PDF_COLORS.ink);
      wrapped.forEach((text, index) => doc.text(text, x + 4, lineTop + ascent(metrics.body) + index * 3.6));
      lineTop += ascent(metrics.body) + Math.max(0, wrapped.length - 1) * 3.6 + descent(metrics.body) + 0.9;
    }
  };
  if (block.title) {
    renderSection(ctx, `paragraph:${block.title}`, block.title, PDF_SECTION_COLORS.psychology, x, width, total, body);
    return;
  }
  const top = reserveBlock(ctx, { id: "paragraph:flow", kind: "text", x, width, height: total });
  body(top);
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
    target.height += paragraphHeight(ctx, block, width);
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
/**
 * Validates the measured layout of the finished document.
 *
 * Every block the renderer reserved is compared with every other block on the same
 * page; a collision is reported on the console with both block ids, so a layout
 * regression is diagnosable from a development run instead of from paper. The result
 * is also returned so a test can assert a clean document.
 */
function validateLayout(ctx: Ctx) {
  const overlaps = findLayoutOverlaps(ctx.blocks);
  if (overlaps.length) console.error(`PDF OVERLAP:\n${overlaps.join("\n")}`);
  return { blocks: ctx.blocks, overlaps };
}

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
    page: 1,
    blocks: [],
  };
  if (!options.trades.length) {
    renderEmptyReport(ctx, options);
    const total = doc.getNumberOfPages();
    renderFooters(doc, options, total);
    return { pages: total, trades: 0, layout: validateLayout(ctx) };
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
  return { pages: total, trades: options.trades.length, summary: options.summary, analysis, layout: validateLayout(ctx) };
}
