/**
 * The canonical Trade Card export model.
 *
 * `TradeDetailDialog` is the authoritative view of a trade (`Trade data →
 * canonical Trade Card model → UI Trade Card`). This module is the *same* step
 * for export (`Trade data → canonical Trade Card model → PDF Trade Card`), so
 * the PDF cannot drift away from the trade card a trader sees on screen.
 *
 * Rules this module enforces:
 *   • every persisted trade field has a labelled home in one of the sections, so
 *     nothing that is readable on the card can be silently dropped from the PDF;
 *   • a field that exists but was never recorded renders `—` instead of
 *     disappearing, which keeps the exported schema honest;
 *   • a persisted property this module does not know about is surfaced in an
 *     "additional recorded fields" list instead of being discarded, so adding a
 *     new column cannot quietly miss the export;
 *   • internal plumbing (`userId`, `accountId`, `screenshotKey`, timestamps,
 *     `clientMutationId`) never reaches the document. The private storage KEY is
 *     the only thing kept back — the browser-facing signed `screenshotUrl` and
 *     the non-sensitive original `screenshotName` travel with the trade exactly
 *     as they do in the UI.
 *
 * Text is sanitized for the PDF writer (control characters removed) but is NEVER
 * truncated: long journal entries wrap and continue onto following pages.
 */

import { PRE_TRADE_GATE_ITEMS, TRADE_CLASSIFICATION_LABELS, TRADE_CLASSIFICATION_SUMMARY, classifyTradeProcess, type TradeClassification } from "@/lib/psychology";
import type { TradeProcessAssessment } from "@shared/psychologyEngine";
import { formatActualR, formatDate, formatMoney, formatRr, toNumber } from "@/lib/gold";

/** Rendered in place of a field that exists but carries no recorded value. */
export const PDF_MISSING = "—";

export type PdfTrade = Record<string, unknown> & { id?: number | string | null };

export type TradePdfField = { label: string; value: string };
export type TradePdfSection = { id: string; title: string; fields: TradePdfField[] };
export type TradePdfEvidence = { url: string | null; filename: string | null; hasScreenshot: boolean };

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
  sections: TradePdfSection[];
  psychology: { before: string; during: string; after: string };
  journalNotes: string;
  evidence: TradePdfEvidence;
  additionalFields: TradePdfField[];
};

export type TradePdfModelOptions = { runningBalance?: number | null };

/**
 * Technical sanitization only. User text is never sliced: the PDF writer wraps
 * it and continues onto another page instead of dropping characters. Carriage
 * returns are normalized so a pasted Windows note keeps its line structure.
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
 * The complete checklist display: every confirmed item plus every gate item that
 * was left unconfirmed, so "not evaluated" is visible rather than implied.
 */
export function checklistText(value: unknown): string {
  const recorded = normalizeChecklist(value);
  if (!recorded.length) return PDF_MISSING;
  const remaining = new Map(recorded.map(item => [item.id, item]));
  const lines: string[] = [];
  for (const item of PRE_TRADE_GATE_ITEMS) {
    const entry = remaining.get(item.id);
    if (!entry) { lines.push(`✗ ${item.label} — not confirmed`); continue; }
    lines.push(entry.checked ? `✓ ${item.label}` : `✗ ${item.label} — not confirmed`);
    remaining.delete(item.id);
  }
  // Anything recorded outside the current gate is still the trader's own record.
  for (const entry of recorded) if (remaining.has(entry.id)) lines.push(`${entry.checked ? "✓" : "✗"} ${entry.label}`);
  return lines.join("\n");
}

/** `confirmed / total` checklist completion, or `—` when nothing was recorded. */
export function checklistCompletion(value: unknown): string {
  const recorded = normalizeChecklist(value);
  if (!recorded.length) return PDF_MISSING;
  return `${recorded.filter(item => item.checked).length} / ${PRE_TRADE_GATE_ITEMS.length} checks confirmed`;
}

function processClassification(assessment: TradeProcessAssessment): string {
  const label = TRADE_CLASSIFICATION_LABELS[assessment.classification as TradeClassification] ?? PDF_MISSING;
  const summary = TRADE_CLASSIFICATION_SUMMARY[assessment.classification as TradeClassification] ?? "";
  return summary ? `${label} — ${summary}` : label;
}

function processReasons(assessment: TradeProcessAssessment): string {
  const lines = [...assessment.reasons, ...assessment.observed];
  return lines.length ? lines.join("\n") : PDF_MISSING;
}

/* ------------------------------------------------------------------ *
 * Field mapping
 * ------------------------------------------------------------------ */

type FieldSpec = { label: string; keys: string[]; value: (trade: PdfTrade, context: ModelContext) => string };

type ModelContext = { runningBalance?: number | null; process: TradeProcessAssessment };

export const TRADE_PDF_SECTIONS: Array<{ id: string; title: string; fields: FieldSpec[] }> = [
  {
    id: "A",
    title: "Trade details",
    fields: [
      { label: "Trade ID", keys: ["id"], value: trade => tradeIdLabel(trade.id) },
      { label: "Trade date", keys: ["tradeDate"], value: trade => pdfTextValue(formatDate(trade.tradeDate as string | number | Date)) },
      { label: "Symbol", keys: ["symbol"], value: trade => pdfTextValue(trade.symbol) },
      { label: "MT5 ticket", keys: ["mt5Ticket"], value: trade => (isBlank(trade.mt5Ticket) ? PDF_MISSING : `#${pdfSafeText(trade.mt5Ticket)}`) },
      { label: "Session", keys: ["session"], value: trade => pdfTextValue(trade.session) },
      { label: "Direction", keys: ["direction"], value: trade => pdfTextValue(trade.direction) },
      { label: "Result", keys: ["result"], value: trade => pdfTextValue(pdfSafeText(trade.result).replace(/_/g, " ")) },
      { label: "Timeframe", keys: ["timeframe"], value: trade => pdfTextValue(trade.timeframe) },
    ],
  },
  {
    id: "B",
    title: "Strategy",
    fields: [
      { label: "Level / confluence", keys: ["level"], value: trade => pdfTextValue(trade.level) },
      { label: "Setup quality", keys: ["setupQuality"], value: trade => pdfTextValue(trade.setupQuality) },
      { label: "Confirmation", keys: ["confirmationType"], value: trade => pdfTextValue(trade.confirmationType) },
      { label: "Market condition", keys: ["marketCondition"], value: trade => pdfTextValue(trade.marketCondition) },
      { label: "Bias alignment", keys: ["biasAlignment"], value: trade => pdfTextValue(trade.biasAlignment) },
    ],
  },
  {
    id: "C",
    title: "Execution",
    fields: [
      { label: "Execution type", keys: ["executionType"], value: trade => pdfTextValue(trade.executionType) },
      { label: "SL placement", keys: ["slPlacement"], value: trade => pdfTextValue(trade.slPlacement) },
      { label: "TP placement", keys: ["tpPlacement"], value: trade => pdfTextValue(trade.tpPlacement) },
      { label: "Hold quality", keys: ["holdQuality"], value: trade => pdfTextValue(trade.holdQuality) },
      { label: "Patience score", keys: ["patienceScore"], value: trade => (isBlank(trade.patienceScore) ? PDF_MISSING : `${pdfSafeText(trade.patienceScore)}/5`) },
      { label: "Mistake / rule-break tags", keys: ["mistake"], value: trade => pdfTextValue(trade.mistake) },
      { label: "Open time (MT5)", keys: ["openTime"], value: trade => formatPktDateTime(trade.openTime) },
      { label: "Close time (MT5)", keys: ["closeTime"], value: trade => formatPktDateTime(trade.closeTime) },
      { label: "Trade duration", keys: [], value: trade => duration(trade) },
    ],
  },
  {
    id: "D",
    title: "Risk & performance",
    fields: [
      { label: "Planned risk", keys: ["risk"], value: trade => money(trade.risk) },
      { label: "Planned reward", keys: ["reward"], value: trade => money(trade.reward) },
      { label: "Planned R:R", keys: ["risk", "reward"], value: trade => rr(trade.risk, trade.reward) },
      { label: "Actual P&L", keys: ["pnl"], value: trade => money(trade.pnl) },
      { label: "Actual R", keys: ["risk", "pnl"], value: trade => actualR(trade.risk, trade.pnl) },
      { label: "Running balance", keys: ["runningBalance"], value: (_trade, context) => (context.runningBalance == null ? PDF_MISSING : formatMoney(context.runningBalance)) },
      { label: "MFE", keys: ["mfe"], value: trade => money(trade.mfe) },
      { label: "MAE", keys: ["mae"], value: trade => money(trade.mae) },
    ],
  },
  {
    id: "E",
    title: "Plan & discipline",
    fields: [
      { label: "Plan status", keys: ["planStatus"], value: trade => pdfTextValue(trade.planStatus) },
      { label: "Planned / unplanned", keys: ["planStatus"], value: trade => (isBlank(trade.planStatus) ? PDF_MISSING : PLAN_STATUS_LABELS[pdfSafeText(trade.planStatus).toUpperCase()] ?? pdfSafeText(trade.planStatus)) },
      { label: "Pre-trade checklist", keys: ["planChecklist"], value: trade => checklistText(trade.planChecklist) },
      { label: "Checklist completion", keys: ["planChecklist"], value: trade => checklistCompletion(trade.planChecklist) },
      { label: "Process classification", keys: [], value: (_trade, context) => processClassification(context.process) },
      { label: "Rule adherence", keys: [], value: (_trade, context) => (context.process.ruleAdherence == null ? PDF_MISSING : `${Math.round(context.process.ruleAdherence)}%`) },
      { label: "Process review", keys: [], value: (_trade, context) => processReasons(context.process) },
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
 * show. A future column therefore appears in the PDF automatically instead of
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
 * source of truth for the PDF trade card; the report writer only lays it out.
 */
export function buildTradePdfModel(trade: PdfTrade, options: TradePdfModelOptions = {}): TradePdfModel {
  const process = classifyTradeProcess(trade as Parameters<typeof classifyTradeProcess>[0]);
  const context: ModelContext = { runningBalance: options.runningBalance ?? null, process };
  const sections: TradePdfSection[] = TRADE_PDF_SECTIONS.map(section => ({
    id: section.id,
    title: section.title,
    fields: section.fields.map(field => ({ label: field.label, value: field.value(trade, context) })),
  }));
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
    sections,
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
