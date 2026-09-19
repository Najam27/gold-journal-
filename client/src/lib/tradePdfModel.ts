/**
 * The canonical Trade Card export model.
 *
 * `TradeDetailDialog` is the authoritative view of a trade (`Trade data →
 * canonical Trade Card model → UI Trade Card`). This module is the *same* step
 * for export (`Trade data → canonical Trade Card model → PDF report`), so the
 * document cannot drift away from the trade a trader sees on screen.
 *
 * The model is presentation-neutral but structured for a report: every field
 * carries its own label, value, tone, and layout hint, and the trade's key
 * figures, checklist state, and process classification are exposed as typed data
 * rather than being re-derived by the renderer. A new persisted column therefore
 * has exactly one place to appear, and a new report block can only show what the
 * model already publishes.
 *
 * Rules this module enforces:
 *   • every persisted trade field has a labelled home, so nothing readable on the
 *     card can be silently dropped from the report;
 *   • a field that exists but was never recorded renders `—` instead of
 *     disappearing, which keeps the exported schema honest;
 *   • a persisted property this module does not know about is surfaced under
 *     "Additional recorded fields" instead of being discarded;
 *   • internal plumbing (`userId`, `accountId`, `screenshotKey`, timestamps,
 *     `clientMutationId`) never reaches the document — the browser-facing signed
 *     `screenshotUrl` and the original `screenshotName` travel with the trade
 *     exactly as they do in the UI.
 *
 * Text is sanitized for the PDF writer (control characters removed) but is NEVER
 * truncated: long journal entries wrap and continue onto another page.
 */

import { MISTAKE_BY_TAG, PRE_TRADE_GATE_ITEMS, TRADE_CLASSIFICATION_LABELS, TRADE_CLASSIFICATION_SUMMARY, classifyTradeProcess, detectBehavioralTags, type TradeClassification } from "@/lib/psychology";
import { tagsForCategory, violationTags, type MistakeCategory, type TradeProcessAssessment } from "@shared/psychologyEngine";
import { formatActualR, formatDate, formatMoney, formatRr, toNumber } from "@/lib/gold";

/** Rendered in place of a field that exists but carries no recorded value. */
export const PDF_MISSING = "—";

export type PdfTrade = Record<string, unknown> & { id?: number | string | null };

/**
 * How a value should be presented. `signed` means "colour it by the sign of the
 * number it holds", which is what every P&L, risk, and R figure wants; the other
 * tones are fixed.
 */
export type TradePdfTone = "neutral" | "positive" | "negative" | "signed" | "accent" | "warning";

export type TradePdfField = {
  label: string;
  value: string;
  /** Layout hint: the value is long, so the report gives it the full column. */
  wide?: boolean;
  tone?: TradePdfTone;
  /** Marks the field as one of the trade's headline figures (the KPI strip). */
  kpi?: boolean;
};

export type TradePdfSection = { id: string; title: string; fields: TradePdfField[] };
export type TradePdfEvidence = { url: string | null; filename: string | null; hasScreenshot: boolean };
export type TradePdfKpi = { label: string; value: string; tone: TradePdfTone };
export type TradePdfChecklistItem = { label: string; confirmed: boolean; recorded: boolean };
export type TradePdfClassification = { key: TradeClassification; label: string; summary: string; tone: TradePdfTone };

export type TradePdfModel = {
  id: number | string | null;
  idLabel: string;
  tradeDate: string;
  symbol: string;
  direction: string;
  result: string;
  session: string;
  pnl: string;
  pnlValue: number;
  /** Headline figures in the order the report's KPI strip presents them. */
  kpis: TradePdfKpi[];
  sections: TradePdfSection[];
  /** Every gate item plus anything recorded outside the current gate. */
  checklist: TradePdfChecklistItem[];
  /** Outcome-independent process verdict, shown separately from P&L. */
  classification: TradePdfClassification;
  psychology: { before: string; during: string; after: string };
  journalNotes: string;
  evidence: TradePdfEvidence;
  additionalFields: TradePdfField[];
};

export type TradePdfModelOptions = { runningBalance?: number | null };

/**
 * Technical sanitization only. User text is never sliced: the report wraps it and
 * continues onto another page instead of dropping characters. Carriage returns
 * are normalized so a pasted Windows note keeps its line structure.
 */
export function pdfSafeText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  const text = typeof value === "string" ? value : String(value);
  return text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** A sanitized value, or the explicit missing marker when nothing was recorded. */
export function pdfTextValue(value: unknown): string {
  const text = pdfSafeText(value);
  return text.trim() === "" ? PDF_MISSING : text;
}

/** Resolves a field's tone against its own value (used by every consumer). */
export function fieldTone(field: { tone?: TradePdfTone; value: string }): TradePdfTone {
  if (field.tone !== "signed") return field.tone ?? "neutral";
  if (field.value === PDF_MISSING) return "neutral";
  return field.value.trim().startsWith("-") ? "negative" : "positive";
}

function isBlank(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

function money(value: unknown): string {
  return isBlank(value) ? PDF_MISSING : formatMoney(toNumber(value));
}

function rr(risk: unknown, reward: unknown): string {
  const formatted = formatRr(toNumber(risk), toNumber(reward));
  return formatted === PDF_MISSING && (isBlank(risk) || isBlank(reward)) ? PDF_MISSING : formatted;
}

function actualR(risk: unknown, pnl: unknown): string {
  if (isBlank(risk) || isBlank(pnl)) return PDF_MISSING;
  return formatActualR(risk as number | string | null, pnl as number | string | null);
}

/** Pakistan-time date and time, used for the MT5 execution timestamps. */
export function formatPktDateTime(value: unknown): string {
  if (isBlank(value)) return PDF_MISSING;
  const date = new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) return PDF_MISSING;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" }).format(date);
}

function duration(trade: PdfTrade): string {
  if (isBlank(trade.openTime) || isBlank(trade.closeTime)) return PDF_MISSING;
  const open = new Date(trade.openTime as string).getTime();
  const close = new Date(trade.closeTime as string).getTime();
  if (!Number.isFinite(open) || !Number.isFinite(close) || close < open) return PDF_MISSING;
  const minutes = Math.round((close - open) / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** Trade ID as shown on the card. A negative id is an unsynced local record. */
export function tradeIdLabel(value: unknown): string {
  if (value == null || value === "") return PDF_MISSING;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric < 0) return "Pending sync (local record)";
  return pdfSafeText(value);
}

const PLAN_STATUS_LABELS: Record<string, string> = { PLANNED: "Planned entry", UNPLANNED: "Unplanned entry", NOT_EVALUATED: "Not evaluated" };

export type ChecklistItem = { id: string; label: string; checked: boolean };

/**
 * Normalizes both persisted checklist shapes into one list: the dialog writes a
 * pipe-separated id string, while the API contract stores an array of
 * `{ id, label, checked }` rows. Nothing is dropped — an id that is not part of
 * the current gate is still reported, because it is what the trader recorded.
 */
export function normalizeChecklist(value: unknown): ChecklistItem[] {
  const entries: ChecklistItem[] = [];
  const push = (id: unknown, label: unknown, checked: unknown) => {
    const key = pdfSafeText(id).trim();
    if (!key) return;
    const gate = PRE_TRADE_GATE_ITEMS.find(item => item.id === key);
    entries.push({ id: key, label: pdfSafeText(label).trim() || gate?.label || key, checked: checked !== false });
  };
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === "object") {
        const row = entry as Record<string, unknown>;
        push(row.id, row.label, row.checked ?? row.yes ?? true);
      } else {
        push(entry, undefined, true);
      }
    }
  } else {
    const text = pdfSafeText(value).trim();
    if (text) for (const token of text.split(/[|,;]/)) push(token.trim(), undefined, true);
  }
  return entries;
}

/**
 * The complete checklist as report-ready rows: every confirmed item, then every
 * gate item that was left unconfirmed, so "not evaluated" is visible rather than
 * implied. `recorded` distinguishes "left unchecked" from "never saved at all".
 */
export function checklistItems(value: unknown): TradePdfChecklistItem[] {
  const recorded = normalizeChecklist(value);
  const remaining = new Map(recorded.map(item => [item.id, item]));
  const items: TradePdfChecklistItem[] = [];
  for (const gate of PRE_TRADE_GATE_ITEMS) {
    const entry = remaining.get(gate.id);
    if (!entry) { items.push({ label: gate.label, confirmed: false, recorded: false }); continue; }
    items.push({ label: entry.label, confirmed: entry.checked, recorded: true });
    remaining.delete(gate.id);
  }
  // Anything recorded outside the current gate is still the trader's own record.
  for (const entry of recorded) if (remaining.has(entry.id)) items.push({ label: entry.label, confirmed: entry.checked, recorded: true });
  return items;
}

/**
 * The checklist as text, for the copy-friendly view. `—` when the trade saved no
 * checklist at all: the gate items still appear in the structured rows the report
 * draws, but a text field should not invent a checklist that was never given.
 */
export function checklistText(value: unknown): string {
  const items = checklistItems(value);
  if (!items.some(item => item.recorded)) return PDF_MISSING;
  return items.map(item => `${item.confirmed ? "✓" : "✗"} ${item.label}${item.confirmed ? "" : " — not confirmed"}`).join("\n");
}

export function checklistCompletion(value: unknown): string {
  const ratio = checklistCompletionRatio(value);
  if (ratio == null) return PDF_MISSING;
  return `${Math.round(ratio.checked)} / ${ratio.total} checks confirmed`;
}

/**
 * The checklist completion ratio in a machine-readable shape, so the report can
 * average it without parsing the display string. `null` when nothing was saved.
 */
export function checklistCompletionRatio(value: unknown): { checked: number; total: number; percentage: number } | null {
  const items = checklistItems(value);
  if (!items.some(item => item.recorded)) return null;
  const total = PRE_TRADE_GATE_ITEMS.length;
  const checked = items.filter(item => item.confirmed).length;
  return { checked, total, percentage: total ? Math.round(checked / total * 1000) / 10 : 0 };
}

/**
 * The tagged behavioural breakdown of a trade: rule breaks, then the analytical,
 * execution, emotional, and environmental groupings the psychology engine already
 * assigns. Nothing is invented — a tag the taxonomy does not recognise simply
 * does not appear here, and stays visible in the raw tag field beside it.
 */
export function mistakeTags(trade: PdfTrade, options: { category?: MistakeCategory; violationsOnly?: boolean }): string {
  const { tags } = detectBehavioralTags(trade.mistake);
  const selected = options.violationsOnly ? violationTags(tags) : options.category ? tagsForCategory(tags, options.category) : tags;
  if (!selected.length) return PDF_MISSING;
  return selected.map(tag => MISTAKE_BY_TAG[tag]?.label ?? tag).join(" · ");
}

function processClassification(process: TradeProcessAssessment): TradePdfClassification {
  const key = process.classification;
  const labels: Record<TradeClassification, { tone: TradePdfTone }> = {
    GOOD_WIN: { tone: "positive" },
    BAD_WIN: { tone: "warning" },
    GOOD_LOSS: { tone: "accent" },
    BAD_LOSS: { tone: "negative" },
    NOT_EVALUATED: { tone: "neutral" },
  };
  return {
    key,
    label: TRADE_CLASSIFICATION_LABELS[key] ?? PDF_MISSING,
    summary: TRADE_CLASSIFICATION_SUMMARY[key] ?? "",
    tone: labels[key]?.tone ?? "neutral",
  };
}

function processReasons(process: TradeProcessAssessment): string {
  const lines = [...process.reasons, ...process.observed];
  return lines.length ? lines.join("\n") : PDF_MISSING;
}

/* ------------------------------------------------------------------ *
 * Field mapping
 * ------------------------------------------------------------------ */

type FieldSpec = { label: string; keys: string[]; value: (trade: PdfTrade, context: ModelContext) => string; wide?: boolean; tone?: TradePdfTone; kpi?: boolean };

type ModelContext = { runningBalance?: number | null; process: TradeProcessAssessment; classification: TradePdfClassification };

export const TRADE_PDF_SECTIONS: Array<{ id: string; title: string; fields: FieldSpec[] }> = [
  {
    id: "A",
    title: "Trade overview",
    fields: [
      { label: "Trade ID", keys: ["id"], value: trade => tradeIdLabel(trade.id) },
      { label: "MT5 ticket", keys: ["mt5Ticket"], value: trade => (isBlank(trade.mt5Ticket) ? PDF_MISSING : `#${pdfSafeText(trade.mt5Ticket)}`) },
      { label: "Trade date", keys: ["tradeDate"], value: trade => pdfTextValue(formatDate(trade.tradeDate as string | number | Date)) },
      { label: "Symbol", keys: ["symbol"], value: trade => pdfTextValue(trade.symbol) },
      { label: "Session", keys: ["session"], value: trade => pdfTextValue(trade.session) },
      { label: "Direction", keys: ["direction"], value: trade => pdfTextValue(trade.direction) },
      { label: "Result", keys: ["result"], value: trade => pdfTextValue(pdfSafeText(trade.result).replace(/_/g, " ")) },
      { label: "Timeframe", keys: ["timeframe"], value: trade => pdfTextValue(trade.timeframe) },
      { label: "Open time (MT5)", keys: ["openTime"], value: trade => formatPktDateTime(trade.openTime) },
      { label: "Close time (MT5)", keys: ["closeTime"], value: trade => formatPktDateTime(trade.closeTime) },
      { label: "Trade duration", keys: [], value: trade => duration(trade) },
    ],
  },
  {
    id: "B",
    title: "Strategy & execution",
    fields: [
      { label: "Level / confluence", keys: ["level"], value: trade => pdfTextValue(trade.level), wide: true },
      { label: "Setup quality", keys: ["setupQuality"], value: trade => pdfTextValue(trade.setupQuality) },
      { label: "Confirmation", keys: ["confirmationType"], value: trade => pdfTextValue(trade.confirmationType) },
      { label: "Market condition", keys: ["marketCondition"], value: trade => pdfTextValue(trade.marketCondition) },
      { label: "Bias alignment", keys: ["biasAlignment"], value: trade => pdfTextValue(trade.biasAlignment) },
      { label: "Execution type", keys: ["executionType"], value: trade => pdfTextValue(trade.executionType) },
      { label: "SL placement", keys: ["slPlacement"], value: trade => pdfTextValue(trade.slPlacement) },
      { label: "TP placement", keys: ["tpPlacement"], value: trade => pdfTextValue(trade.tpPlacement) },
      { label: "Hold quality", keys: ["holdQuality"], value: trade => pdfTextValue(trade.holdQuality) },
      { label: "Patience score", keys: ["patienceScore"], value: trade => (isBlank(trade.patienceScore) ? PDF_MISSING : `${pdfSafeText(trade.patienceScore)}/5`), kpi: true },
    ],
  },
  {
    id: "C",
    title: "Risk & performance",
    fields: [
      { label: "Planned risk", keys: ["risk"], value: trade => money(trade.risk), tone: "signed" },
      { label: "Planned reward", keys: ["reward"], value: trade => money(trade.reward), tone: "signed" },
      { label: "Planned R:R", keys: ["risk", "reward"], value: trade => rr(trade.risk, trade.reward), kpi: true, tone: "accent" },
      { label: "Actual P&L", keys: ["pnl"], value: trade => money(trade.pnl), kpi: true, tone: "signed" },
      { label: "Actual R", keys: ["risk", "pnl"], value: trade => actualR(trade.risk, trade.pnl), kpi: true, tone: "signed" },
      { label: "Running balance", keys: ["runningBalance"], value: (_trade, context) => (context.runningBalance == null ? PDF_MISSING : formatMoney(context.runningBalance)), tone: "signed" },
      { label: "MFE", keys: ["mfe"], value: trade => money(trade.mfe), tone: "signed" },
      { label: "MAE", keys: ["mae"], value: trade => money(trade.mae), tone: "signed" },
    ],
  },
  {
    id: "D",
    title: "Plan & discipline",
    fields: [
      { label: "Plan status", keys: ["planStatus"], value: trade => pdfTextValue(trade.planStatus) },
      { label: "Planned / unplanned", keys: ["planStatus"], value: trade => (isBlank(trade.planStatus) ? PDF_MISSING : PLAN_STATUS_LABELS[pdfSafeText(trade.planStatus).toUpperCase()] ?? pdfSafeText(trade.planStatus)) },
      { label: "Checklist completion", keys: ["planChecklist"], value: trade => checklistCompletion(trade.planChecklist), kpi: true },
      { label: "Rule adherence", keys: [], value: (_trade, context) => (context.process.ruleAdherence == null ? PDF_MISSING : `${Math.round(context.process.ruleAdherence)}%`), kpi: true },
      { label: "Process classification", keys: [], value: (_trade, context) => (context.classification.summary ? `${context.classification.label} — ${context.classification.summary}` : context.classification.label), tone: "accent", wide: true },
      { label: "Process review", keys: [], value: (_trade, context) => processReasons(context.process), wide: true },
    ],
  },
  {
    id: "E",
    title: "Process & mistakes",
    fields: [
      { label: "Mistake tags", keys: ["mistake"], value: trade => pdfTextValue(trade.mistake), wide: true },
      { label: "Rule-break tags", keys: ["mistake"], value: trade => mistakeTags(trade, { violationsOnly: true }), wide: true },
      { label: "Analytical mistakes", keys: ["mistake"], value: trade => mistakeTags(trade, { category: "ANALYTICAL" }), wide: true },
      { label: "Execution mistakes", keys: ["mistake"], value: trade => mistakeTags(trade, { category: "EXECUTION" }), wide: true },
      { label: "Emotional triggers", keys: ["mistake"], value: trade => mistakeTags(trade, { category: "EMOTIONAL" }), wide: true },
      { label: "Environmental factors", keys: ["mistake"], value: trade => mistakeTags(trade, { category: "ENVIRONMENTAL" }), wide: true },
    ],
  },
];

/** Persisted keys this model reads, plus keys it derives rather than stores. */
export const TRADE_PDF_MAPPED_KEYS: string[] = Array.from(new Set([...TRADE_PDF_SECTIONS.flatMap(section => section.fields.flatMap(field => field.keys)), "emotionBefore", "emotionDuring", "emotionAfter", "notes", "screenshotUrl", "screenshotName", "hasScreenshot", "symbol", "openTime", "closeTime"]));

/**
 * Internal plumbing that must never be exported. `screenshotKey` is deliberately
 * here: it is the private storage path, not trade evidence, and the browser only
 * ever receives the freshly signed `screenshotUrl` for it.
 */
export const TRADE_PDF_INTERNAL_KEYS = ["userId", "accountId", "createdAt", "updatedAt", "screenshotKey", "clientMutationId", "localPending"];

/** The KPI strip's figures, in the order the report presents them. */
export const TRADE_PDF_KPI_LABELS = ["Actual P&L", "Actual R", "Planned R:R", "Rule adherence", "Checklist completion", "Patience score"];

function additionalValue(value: unknown): string | null {
  if (isBlank(value)) return null;
  if (typeof value === "object") {
    if (value instanceof Date) return formatPktDateTime(value);
    try {
      const serialized = JSON.stringify(value);
      return serialized && serialized !== "{}" && serialized !== "[]" ? serialized : null;
    } catch {
      return null;
    }
  }
  return pdfSafeText(value);
}

/**
 * Everything the trade record carries that the sections above do not already
 * show. A future column therefore appears in the report automatically instead of
 * being forgotten, while internal plumbing stays out.
 */
export function additionalTradeFields(trade: PdfTrade): TradePdfField[] {
  const mapped = new Set([...TRADE_PDF_MAPPED_KEYS, ...TRADE_PDF_INTERNAL_KEYS]);
  const fields: TradePdfField[] = [];
  for (const key of Object.keys(trade).sort()) {
    if (mapped.has(key)) continue;
    const value = additionalValue(trade[key]);
    if (value == null) continue;
    fields.push({ label: key, value });
  }
  return fields;
}

/**
 * Builds the complete exported representation of one trade. This is the single
 * source of truth for the PDF report; the renderer only lays it out.
 */
export function buildTradePdfModel(trade: PdfTrade, options: TradePdfModelOptions = {}): TradePdfModel {
  const process = classifyTradeProcess(trade as Parameters<typeof classifyTradeProcess>[0]);
  const classification = processClassification(process);
  const context: ModelContext = { runningBalance: options.runningBalance ?? null, process, classification };
  const sections: TradePdfSection[] = TRADE_PDF_SECTIONS.map(section => ({
    id: section.id,
    title: section.title,
    fields: section.fields.map(field => ({ label: field.label, value: field.value(trade, context), wide: field.wide, tone: field.tone, kpi: field.kpi })),
  }));
  const allFields = sections.flatMap(section => section.fields);
  const byLabel = new Map(allFields.map(field => [field.label, field]));
  const kpis: TradePdfKpi[] = TRADE_PDF_KPI_LABELS
    .map(label => byLabel.get(label))
    .filter((field): field is TradePdfField => Boolean(field))
    .map(field => ({ label: field.label, value: field.value, tone: fieldTone(field) }));
  const result = pdfSafeText(trade.result);
  return {
    id: (trade.id ?? null) as number | string | null,
    idLabel: tradeIdLabel(trade.id),
    tradeDate: formatDate(trade.tradeDate as string | number | Date),
    symbol: pdfTextValue(trade.symbol),
    direction: pdfTextValue(trade.direction),
    result: result.trim() === "" ? PDF_MISSING : result.replace(/_/g, " "),
    session: pdfTextValue(trade.session),
    pnl: money(trade.pnl),
    pnlValue: toNumber(trade.pnl),
    kpis,
    sections,
    checklist: checklistItems(trade.planChecklist),
    classification,
    psychology: {
      before: pdfSafeText(trade.emotionBefore),
      during: pdfSafeText(trade.emotionDuring),
      after: pdfSafeText(trade.emotionAfter),
    },
    journalNotes: pdfSafeText(trade.notes),
    evidence: {
      url: isBlank(trade.screenshotUrl) ? null : pdfSafeText(trade.screenshotUrl),
      filename: isBlank(trade.screenshotName) ? null : pdfSafeText(trade.screenshotName),
      hasScreenshot: Boolean(trade.hasScreenshot) || !isBlank(trade.screenshotKey) || !isBlank(trade.screenshotUrl),
    },
    additionalFields: additionalTradeFields(trade),
  };
}
