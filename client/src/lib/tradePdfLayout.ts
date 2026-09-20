/**
 * The shared page-layout system behind the PDF report.
 *
 * Every document this application writes goes through one vertical cursor: `ctx.y`
 * is always the top of the *next free* space, never a text baseline and never a
 * hard-coded Y. A block measures itself, reserves its height, and only then draws
 * inside the reserved box, so the block below always starts below the block above.
 *
 * Text follows the same discipline. A run of `n` lines at `fontSize` occupies
 * `ascent + (n - 1) * lineHeight + descent`, and its first baseline sits one
 * ascender below the top of its box. A coloured section band therefore leaves a
 * fixed `SECTION_GAP` of clear space before the first line of its content, and the
 * band's own title is the only text allowed inside the band.
 *
 * `reserveBlock` also records every box it hands out, so the finished document can
 * be validated: `findLayoutOverlaps` reports any two blocks on one page that share
 * space, which is how a layout regression is caught in development instead of on
 * paper.
 *
 * The palette here is the document's own print palette — a neutral page, dark ink,
 * fixed positive/negative treatment — so neither the application theme (light or
 * dark) nor a dark-mode class can change how the report reads or prints.
 *
 * A `PdfDoc` is passed in rather than a concrete jsPDF instance, so layout,
 * pagination, and overlap rules are unit-testable in Node while the application
 * passes a real jsPDF document.
 */

import {
  PRESENTATION_MISSING,
  TRADE_HEADER_ACCENT,
  TRADE_SECTION_THEME,
  resolveTone,
  type TradePresentationSectionId,
  type TradeTone,
} from "./tradePresentation";

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

export type Rgb = readonly [number, number, number];

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

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** One typographic point, in millimetres. */
const PT = 0.3528;

/** Ascender height above the baseline for a Helvetica run, in mm. */
export function ascent(fontSize: number) { return fontSize * PT * 0.78; }

/** Descender depth below the baseline for a Helvetica run, in mm. */
export function descent(fontSize: number) { return fontSize * PT * 0.24; }

/**
 * The clear space every coloured section band leaves before its content. This is
 * the report's no-overlap rule: a band and the text that belongs to it never share
 * a vertical area (10 pt ≈ 3.5 mm on paper).
 */
export const SECTION_GAP = 2.8;

/** A measured rectangle of the finished document, used for overlap validation. */
export type PdfLayoutBlock = {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  kind: "band" | "text" | "table" | "panel" | "image";
  /** Present on a band: the title it prints, which is the only text allowed inside it. */
  title?: string;
};

/** Two rectangles on one page that share more than this much space are a collision. */
const OVERLAP_X_TOLERANCE = 1;
const OVERLAP_Y_TOLERANCE = 0.6;

/**
 * Finds every real collision in a measured document — text over a band, a table
 * over a neighbouring table, a section over the section above it.
 *
 * Panels and images are containers: their content is drawn *inside* them, so they
 * are never reported against the text they hold. Everything else is compared, and
 * a rectangle that merely grazes its neighbour by less than the tolerance is not a
 * collision. The message names both blocks so a layout regression is diagnosable
 * from the console alone.
 */
export function findLayoutOverlaps(blocks: PdfLayoutBlock[], tolerance = { x: OVERLAP_X_TOLERANCE, y: OVERLAP_Y_TOLERANCE }): string[] {
  const problems: string[] = [];
  const comparable = blocks.filter(block => block.kind !== "panel" && block.kind !== "image");
  for (let index = 0; index < comparable.length; index += 1) {
    const a = comparable[index];
    for (const b of comparable.slice(index + 1)) {
      if (a.page !== b.page) continue;
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (overlapX > tolerance.x && overlapY > tolerance.y) problems.push(`${a.id} intersects ${b.id} on page ${a.page}`);
    }
  }
  return problems;
}

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

export function toneColor(tone: TradeTone | undefined, value?: string): Rgb {
  const resolved = tone === "signed" && value ? resolveTone({ tone, value }) : tone ?? "neutral";
  if (resolved === "signed") return PDF_COLORS.ink;
  return TONE_COLORS[resolved] ?? PDF_COLORS.ink;
}

export function toneTint(tone: TradeTone | undefined, value?: string): Rgb {
  const resolved = tone === "signed" && value ? resolveTone({ tone, value }) : tone ?? "neutral";
  return TONE_TINTS[resolved] ?? PDF_COLORS.panel;
}

/* ------------------------------------------------------------------ *
 * Typography
 * ------------------------------------------------------------------ */

export type Metrics = {
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
export const TRADE_METRICS: Metrics[] = [
  { body: 8, line: 3.5, label: 7.4, labelLine: 3, gap: 7, rowGap: 1.2, section: 8, sectionAdvance: 4.4, title: 17 },
  { body: 7.8, line: 3.3, label: 7.3, labelLine: 2.9, gap: 6.5, rowGap: 1, section: 7.8, sectionAdvance: 4.2, title: 16 },
  { body: 7.5, line: 3.1, label: 7.2, labelLine: 2.8, gap: 6, rowGap: 0.8, section: 7.6, sectionAdvance: 4, title: 16 },
  { body: 7.2, line: 3, label: 7.1, labelLine: 2.7, gap: 5.5, rowGap: 0.6, section: 7.4, sectionAdvance: 3.9, title: 15 },
  { body: 7, line: 2.9, label: 7, labelLine: 2.6, gap: 5, rowGap: 0.5, section: 7.2, sectionAdvance: 3.8, title: 15 },
];

export const ANALYSIS_METRICS: Metrics = { body: 7.6, line: 3.4, label: 7.2, labelLine: 3, gap: 6, rowGap: 1.1, section: 8, sectionAdvance: 4.8, title: 16 };
export const TABLE_FONT = { title: 7.6, header: 7, body: 7.2, line: 3.4, padding: 0.8 };

/**
 * The smallest type the report's read content uses: eyebrows, KPI labels, field
 * labels, table headers, and body text all stay at or above this.
 */
export const PDF_MIN_FONT = 7;
export const METRIC_COLUMNS = 4;
export const KPI_COLUMNS = 6;

/** Height of the page header band, and of the body area it leaves behind. */
export const HEADER_HEIGHT = 15;
export const SCREENSHOT_CAPTION = 5;
/** Height of the trade page's KPI tile strip, including its gap. */
export const KPI_STRIP_HEIGHT = 14;

/* ------------------------------------------------------------------ *
 * Context and primitives
 * ------------------------------------------------------------------ */

export type Ctx = {
  doc: PdfDoc;
  /** The first page already exists in jsPDF, so it is painted rather than added. */
  started: boolean;
  /** Top of the next free vertical space. Never used as a text baseline. */
  y: number;
  bodyTop: number;
  bottom: number;
  contentWidth: number;
  metrics: Metrics;
  header: { eyebrow: string; title: string; continued: string; caption?: string };
  titleSize: number;
  /** The page a block currently being measured or drawn lands on. */
  page: number;
  /** Every measured block of the document, for overlap validation. */
  blocks: PdfLayoutBlock[];
};

export function setFill(doc: PdfDoc, color: Rgb) { doc.setFillColor(color[0], color[1], color[2]); }
export function setText(doc: PdfDoc, color: Rgb) { doc.setTextColor(color[0], color[1], color[2]); }
export function setDraw(doc: PdfDoc, color: Rgb) { doc.setDrawColor?.(color[0], color[1], color[2]); doc.setLineWidth?.(0.2); }
export function contentWidth() { return PDF_PAGE.width - PDF_PAGE.margin * 2; }
export function contentBottom() { return PDF_PAGE.height - PDF_PAGE.margin - 6; }

function paintPage(doc: PdfDoc) {
  setFill(doc, PDF_COLORS.page);
  doc.rect(0, 0, PDF_PAGE.width, PDF_PAGE.height, "F");
}

export function hairline(ctx: Ctx, y: number, x: number, width: number, color: Rgb = PDF_COLORS.rule, height = 0.25) {
  setFill(ctx.doc, color);
  ctx.doc.rect(x, y, width, height, "F");
}

export function panel(ctx: Ctx, x: number, y: number, width: number, height: number, fill: Rgb = PDF_COLORS.panel, border: Rgb = PDF_COLORS.panelLine) {
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

export function startPage(ctx: Ctx, options: { eyebrow: string; title: string; continued: string; caption?: string; titleSize?: number; metrics?: Metrics }) {
  if (ctx.started) ctx.doc.addPage();
  else ctx.started = true;
  ctx.header = { eyebrow: options.eyebrow, title: options.title, continued: options.continued, caption: options.caption };
  ctx.titleSize = options.titleSize ?? 16;
  ctx.metrics = options.metrics ?? TRADE_METRICS[1];
  paintPage(ctx.doc);
  ctx.page = ctx.doc.getNumberOfPages();
  ctx.bodyTop = PDF_PAGE.margin + drawHeader(ctx, options.title);
  ctx.bottom = contentBottom();
  ctx.contentWidth = contentWidth();
  ctx.y = ctx.bodyTop;
}

export function nextPage(ctx: Ctx) {
  startPage(ctx, {
    eyebrow: ctx.header.eyebrow,
    title: ctx.header.continued,
    continued: ctx.header.continued,
    titleSize: Math.min(ctx.titleSize, 15),
    metrics: ctx.metrics,
  });
}

export function ensureSpace(ctx: Ctx, needed: number) {
  if (ctx.y + needed > ctx.bottom) nextPage(ctx);
}

/**
 * Reserves a measured box on the current page and returns its top edge; the cursor
 * is already below the box when this returns, so whatever is drawn into the box
 * cannot move the cursor.
 */
export function reserveBlock(ctx: Ctx, block: Omit<PdfLayoutBlock, "page" | "y">): number {
  ensureSpace(ctx, block.height);
  const top = ctx.y;
  ctx.blocks.push({ ...block, y: top, page: ctx.page });
  ctx.y = top + block.height;
  return top;
}

/** Paints a coloured band with its title in white; the title stays inside the band. */
export function paintBand(ctx: Ctx, title: string, color: Rgb, x: number, top: number, width: number, height: number) {
  panel(ctx, x, top, width, height, color, color);
  // The band title is display type, but it still never drops below the floor.
  ctx.doc.setFontSize(Math.max(PDF_MIN_FONT, ctx.metrics.section - 0.4));
  if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "bold");
  setText(ctx.doc, PDF_COLORS.onAccent);
  ctx.doc.text(title.toUpperCase(), x + 2.4, top + height - 1.5);
  if (ctx.doc.setFont) ctx.doc.setFont("helvetica", "normal");
}

/**
 * A coloured section band plus the content that belongs to it.
 *
 * The band, the gap beneath it, and the content are reserved as one block, so the
 * band can never be drawn over its own content and the next block always starts
 * below the content. `height` must be the exact height of everything drawn by
 * `draw`, which is why every caller measures before it draws.
 */
export function renderSection(ctx: Ctx, id: string, title: string, color: Rgb, x: number, width: number, height: number, draw: (contentTop: number) => void) {
  const bandHeight = ctx.metrics.sectionAdvance;
  // The whole block — band, gap, and content — is claimed before anything is
  // drawn, so the next block can only start below this one. Two rectangles are
  // registered: the coloured band itself (which must stay clear of every other
  // text) and the content box beneath it.
  ensureSpace(ctx, height);
  const top = ctx.y;
  ctx.blocks.push({ id, page: ctx.page, kind: "band", x, y: top, width, height: bandHeight, title: title.toUpperCase() });
  paintBand(ctx, title, color, x, top, width, bandHeight);
  const contentTop = top + bandHeight + SECTION_GAP;
  if (height > bandHeight + SECTION_GAP) ctx.blocks.push({ id: `${id}.content`, page: ctx.page, x, y: contentTop, width, height: height - bandHeight - SECTION_GAP, kind: "text" });
  ctx.y = top + height;
  draw(contentTop);
}

/** A band with no content — the content-less heading used by the analysis pages. */
export function sectionBandOnly(ctx: Ctx, id: string, title: string, color: Rgb, x: number, width: number) {
  renderSection(ctx, id, title, color, x, width, ctx.metrics.sectionAdvance, () => undefined);
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

export function wrapText(doc: PdfDoc, value: string, maxWidth: number): string[] {
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
export function writeWrapped(ctx: Ctx, value: string, options: { x?: number; maxWidth?: number; lineHeight?: number; color?: Rgb; fontSize?: number } = {}) {
  const x = options.x ?? PDF_PAGE.margin;
  const lineHeight = options.lineHeight ?? ctx.metrics.line;
  const maxWidth = options.maxWidth ?? ctx.contentWidth;
  const fontSize = options.fontSize ?? ctx.metrics.body;
  const color = options.color ?? PDF_COLORS.ink;
  for (const line of wrapText(ctx.doc, value, maxWidth)) {
    ensureSpace(ctx, lineHeight);
    ctx.doc.setFontSize(fontSize);
    setText(ctx.doc, color);
    // The baseline sits one ascender below the top of the line's box, so the text
    // never reaches up into the section band above it.
    ctx.doc.text(line, x, ctx.y + ascent(fontSize));
    ctx.y += lineHeight;
  }
}

/**
 * Writes already-wrapped lines that may span pages.
 *
 * Used only where a block genuinely cannot be measured ahead of time (a journal
 * continuation). One measured block is registered per page the run reaches, so the
 * text it writes is still part of the overlap validation.
 */
export function drawLines(ctx: Ctx, id: string, lines: string[], x: number, options: { lineHeight: number; fontSize: number; color?: Rgb; width?: number } = { lineHeight: 3.4, fontSize: 7.2 }) {
  const width = options.width ?? ctx.contentWidth - (x - PDF_PAGE.margin);
  let segmentTop = ctx.y;
  let segmentPage = ctx.page;
  const flush = () => {
    if (ctx.y - segmentTop > 0.2) ctx.blocks.push({ id, page: segmentPage, x, y: segmentTop, width, height: ctx.y - segmentTop, kind: "text" });
  };
  for (const line of lines) {
    if (ctx.y + options.lineHeight > ctx.bottom) {
      flush();
      nextPage(ctx);
      segmentTop = ctx.y;
      segmentPage = ctx.page;
    }
    ctx.doc.setFontSize(options.fontSize);
    setText(ctx.doc, options.color ?? PDF_COLORS.ink);
    ctx.doc.text(line, x, ctx.y + ascent(options.fontSize));
    ctx.y += options.lineHeight;
  }
  flush();
}
