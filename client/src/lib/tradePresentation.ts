/**
 * The canonical Trade Presentation Model — the single source of truth for what a
 * trade *shows* to the trader.
 *
 * The architecture this file implements is deliberately one-way:
 *
 *     persisted trade  ->  buildTradePresentation()  ->  View Trade / Trade Card
 *                                                       Share Trade Card
 *                                                       PDF report
 *
 * The Edit Trade form defines what a trader can record. This module defines the
 * user-facing representation of that record, and every surface renders *this*
 * model instead of maintaining its own hand-picked field list. That is what stops
 * a field from existing in Edit but disappearing from View or the PDF.
 *
 * Three rules are enforced here rather than in each surface:
 *
 *   1. COMPLETENESS — `EDITABLE_TRADE_FIELDS` lists every field the trade form
 *      writes; `TRADE_PRESENTATION_FIELDS` gives each one a labelled home, and the
 *      `tradePresentation.test.ts` completeness guard fails if a new editable field
 *      has no presentation field. A persisted property with no home at all still
 *      surfaces under "Additional recorded fields" rather than being dropped.
 *   2. HONEST EMPTIES — a field that exists but was never recorded renders `—`
 *      instead of vanishing, so the exported schema is stable.
 *   3. NO TECHNICAL METADATA — `TRADE_INTERNAL_KEYS` (MT5 ticket, screenshot
 *      storage key and filename, owner/account ids, audit timestamps, sync
 *      identifiers) never reaches a user-facing surface. The screenshot itself is
 *      evidence and is shown; its plumbing is not.
 *
 * Every field carries its own label, value, tone, and layout hint, and the model
 * also publishes typed KPI figures, checklist rows, the process classification,
 * psychology blocks, the journal entry, and the screenshot evidence — so no
 * renderer has to re-derive (and therefore re-interpret) a single value.
 */

import { MISTAKE_BY_TAG, PRE_TRADE_GATE_ITEMS, TRADE_CLASSIFICATION_LABELS, TRADE_CLASSIFICATION_SUMMARY, classifyTradeProcess, detectBehavioralTags, type TradeClassification } from "@/lib/psychology";
import { tagsForCategory, violationTags, type MistakeCategory, type TradeProcessAssessment } from "@shared/psychologyEngine";
import { formatActualR, formatDate, formatMoney, formatRr, toNumber } from "@/lib/gold";

/** Rendered in place of a field that exists but carries no recorded value. */
export const PRESENTATION_MISSING = "—";

export type PresentationTrade = Record<string, unknown> & { id?: number | string | null };

/**
 * How a value should be presented. `signed` means "colour it by the sign of the
 * number it holds", which is what every P&L, risk, and R figure wants; the other
 * tones are fixed.
 */
export type TradeTone = "neutral" | "positive" | "negative" | "signed" | "accent" | "warning";

export type TradePresentationField = {
  /** Stable field id, shared by the completeness contract and every surface. */
  key: string;
  label: string;
  value: string;
  /** Layout hint: the value is long, so a report gives it the full row width. */
  wide?: boolean;
  tone?: TradeTone;
  /** Marks the field as one of the trade's headline figures (the KPI strip). */
  kpi?: boolean;
  /** Identity already stated in the surface header, so a table omits the row. */
  inHeader?: boolean;
};

export type TradePresentationSectionId = "overview" | "strategy" | "execution" | "risk" | "discipline" | "mistakes" | "psychology" | "journal" | "checklist";

/**
 * Each section's title and accent colour, defined once so the dialog, the share
 * card, and the PDF cannot drift apart. Surfaces convert the hex to whatever they
 * need (CSS custom property, canvas fill, jsPDF RGB).
 */
export const TRADE_SECTION_THEME: Record<TradePresentationSectionId, { title: string; accent: string }> = {
  overview: { title: "Trade overview", accent: "#2F5C9E" },
  strategy: { title: "Strategy", accent: "#7C4DBE" },
  execution: { title: "Execution", accent: "#0E7C86" },
  risk: { title: "Risk & performance", accent: "#A97B12" },
  discipline: { title: "Plan & discipline", accent: "#3B4CC0" },
  checklist: { title: "Pre-trade checklist", accent: "#5C6BC0" },
  mistakes: { title: "Mistakes & behaviour", accent: "#C2453E" },
  psychology: { title: "Psychology", accent: "#A34FC0" },
  journal: { title: "Journal notes", accent: "#5C6672" },
};

/** Brand accent used for the report header and the trade identity band. */
export const TRADE_HEADER_ACCENT = "#B07D1A";

/**
 * The screenshot-evidence block's title and accent. Evidence is not a *field*
 * section — the image is the section — so it carries its own theme entry that the
 * viewer, the share card, and the report all read.
 */
export const TRADE_EVIDENCE_THEME = { title: "Screenshot evidence", accent: "#5C6672" } as const;

export type TradePresentationSection = { id: TradePresentationSectionId; title: string; accent: string; fields: TradePresentationField[] };
export type TradePresentationEvidence = { url: string | null; hasScreenshot: boolean };
export type TradePresentationKpi = { key: string; label: string; value: string; tone: TradeTone };
export type TradePresentationChecklistItem = { label: string; confirmed: boolean; recorded: boolean };
export type TradePresentationClassification = { key: TradeClassification; label: string; summary: string; tone: TradeTone };

export type TradePresentation = {
  id: number | string | null;
  /** The trade's identity, stated once: what every surface's header shows. */
  identity: {
    idLabel: string;
    tradeDate: string;
    symbol: string;
    session: string;
    direction: string;
    result: string;
    pnl: string;
    pnlValue: number;
    /** `16 Sep 2026 · New York · SELL · WIN`, uppercase for report headers. */
    line: string;
  };
  kpis: TradePresentationKpi[];
  sections: TradePresentationSection[];
  checklist: TradePresentationChecklistItem[];
  classification: TradePresentationClassification;
  psychology: { before: string; during: string; after: string };
  journalNotes: string;
  evidence: TradePresentationEvidence;
  /** Persisted properties with no dedicated home, so nothing is silently lost. */
  additionalFields: TradePresentationField[];
};

export type TradePresentationOptions = { runningBalance?: number | null };

/* ------------------------------------------------------------------ *
 * Value helpers
 * ------------------------------------------------------------------ */

/** Technical sanitization only; user text is never sliced or truncated. */
export function presentationSafeText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  const text = typeof value === "string" ? value : String(value);
  return text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** A sanitized value, or the explicit missing marker when nothing was recorded. */
export function presentationText(value: unknown): string {
  const text = presentationSafeText(value);
  return text.trim() === "" ? PRESENTATION_MISSING : text;
}

/** Resolves a field's tone against its own value (used by every surface). */
export function resolveTone(field: { tone?: TradeTone; value: string }): TradeTone {
  if (field.tone !== "signed") return field.tone ?? "neutral";
  if (field.value === PRESENTATION_MISSING) return "neutral";
  return field.value.trim().startsWith("-") ? "negative" : "positive";
}

function isBlank(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

function money(value: unknown): string {
  return isBlank(value) ? PRESENTATION_MISSING : formatMoney(toNumber(value));
}

function rr(risk: unknown, reward: unknown): string {
  const formatted = formatRr(toNumber(risk), toNumber(reward));
  return formatted === PRESENTATION_MISSING && (isBlank(risk) || isBlank(reward)) ? PRESENTATION_MISSING : formatted;
}

function actualR(risk: unknown, pnl: unknown): string {
  if (isBlank(risk) || isBlank(pnl)) return PRESENTATION_MISSING;
  return formatActualR(risk as number | string | null, pnl as number | string | null);
}

/** Pakistan-time date and time, used for the trade's execution timestamps. */
export function formatPktDateTime(value: unknown): string {
  if (isBlank(value)) return PRESENTATION_MISSING;
  const date = new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) return PRESENTATION_MISSING;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", dateStyle: "medium", timeStyle: "short" }).format(date);
}

function duration(trade: PresentationTrade): string {
  if (isBlank(trade.openTime) || isBlank(trade.closeTime)) return PRESENTATION_MISSING;
  const open = new Date(trade.openTime as string).getTime();
  const close = new Date(trade.closeTime as string).getTime();
  if (!Number.isFinite(open) || !Number.isFinite(close) || close < open) return PRESENTATION_MISSING;
  const minutes = Math.round((close - open) / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** The trade reference as shown on screen. A negative id is an unsynced record. */
export function tradeIdLabel(value: unknown): string {
  if (value == null || value === "") return PRESENTATION_MISSING;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric < 0) return "Pending sync (local record)";
  return presentationSafeText(value);
}

const PLAN_STATUS_LABELS: Record<string, string> = { PLANNED: "Planned entry", UNPLANNED: "Unplanned entry", NOT_EVALUATED: "Not evaluated" };

export type ChecklistItem = { id: string; label: string; checked: boolean };

/**
 * Normalizes both persisted checklist shapes into one list: the dialog writes a
 * pipe-separated id string, while the API contract stores an array of
 * `{ id, label, checked }` rows. An id outside the current gate is still reported,
 * because it is what the trader recorded.
 */
export function normalizeChecklist(value: unknown): ChecklistItem[] {
  const entries: ChecklistItem[] = [];
  const push = (id: unknown, label: unknown, checked: unknown) => {
    const key = presentationSafeText(id).trim();
    if (!key) return;
    const gate = PRE_TRADE_GATE_ITEMS.find(item => item.id === key);
    entries.push({ id: key, label: presentationSafeText(label).trim() || gate?.label || key, checked: checked !== false });
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
    const text = presentationSafeText(value).trim();
    if (text) for (const token of text.split(/[|,;]/)) push(token.trim(), undefined, true);
  }
  return entries;
}

/**
 * The complete checklist as presentation rows: every gate item in order, then
 * anything recorded outside the current gate. `recorded` distinguishes "left
 * unchecked" from "never saved at all".
 */
export function checklistItems(value: unknown): TradePresentationChecklistItem[] {
  const recorded = normalizeChecklist(value);
  const remaining = new Map(recorded.map(item => [item.id, item]));
  const items: TradePresentationChecklistItem[] = [];
  for (const gate of PRE_TRADE_GATE_ITEMS) {
    const entry = remaining.get(gate.id);
    if (!entry) { items.push({ label: gate.label, confirmed: false, recorded: false }); continue; }
    items.push({ label: entry.label, confirmed: entry.checked, recorded: true });
    remaining.delete(gate.id);
  }
  for (const entry of recorded) if (remaining.has(entry.id)) items.push({ label: entry.label, confirmed: entry.checked, recorded: true });
  return items;
}

/** The checklist as text. `—` when the trade saved no checklist at all. */
export function checklistText(value: unknown): string {
  const items = checklistItems(value);
  if (!items.some(item => item.recorded)) return PRESENTATION_MISSING;
  return items.map(item => `${item.confirmed ? "✓" : "✗"} ${item.label}${item.confirmed ? "" : " — not confirmed"}`).join("\n");
}

export function checklistCompletion(value: unknown): string {
  const ratio = checklistCompletionRatio(value);
  if (ratio == null) return PRESENTATION_MISSING;
  return `${Math.round(ratio.checked)} / ${ratio.total} checks confirmed`;
}

/**
 * The checklist completion ratio in a machine-readable shape, so a report can
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
 * execution, emotional, and environmental groupings the psychology engine assigns.
 * A tag the taxonomy does not recognise stays visible in the raw tag field.
 */
export function mistakeTags(trade: PresentationTrade, options: { category?: MistakeCategory; violationsOnly?: boolean }): string {
  const { tags } = detectBehavioralTags(trade.mistake);
  const selected = options.violationsOnly ? violationTags(tags) : options.category ? tagsForCategory(tags, options.category) : tags;
  if (!selected.length) return PRESENTATION_MISSING;
  return selected.map(tag => MISTAKE_BY_TAG[tag]?.label ?? tag).join(" · ");
}

function classificationFor(process: TradeProcessAssessment): TradePresentationClassification {
  const key = process.classification;
  const tones: Record<TradeClassification, TradeTone> = {
    GOOD_WIN: "positive",
    BAD_WIN: "warning",
    GOOD_LOSS: "accent",
    BAD_LOSS: "negative",
    NOT_EVALUATED: "neutral",
  };
  return {
    key,
    label: TRADE_CLASSIFICATION_LABELS[key] ?? PRESENTATION_MISSING,
    summary: TRADE_CLASSIFICATION_SUMMARY[key] ?? "",
    tone: tones[key] ?? "neutral",
  };
}

function processReasons(process: TradeProcessAssessment): string {
  const lines = [...process.reasons, ...process.observed];
  return lines.length ? lines.join("\n") : PRESENTATION_MISSING;
}

/* ------------------------------------------------------------------ *
 * Field definitions — the one list every surface renders
 * ------------------------------------------------------------------ */

type FieldSpec = {
  key: string;
  label: string;
  section: TradePresentationSectionId;
  /** Persisted properties this field reads. Drives the completeness guard. */
  keys: string[];
  value: (trade: PresentationTrade, context: PresentationContext) => string;
  wide?: boolean;
  tone?: TradeTone;
  kpi?: boolean;
  inHeader?: boolean;
};

type PresentationContext = { runningBalance?: number | null; process: TradeProcessAssessment; classification: TradePresentationClassification };

/**
 * The canonical user-facing field set. Labels are the contract: View Trade, the
 * share card, and the PDF all print these exact strings, so a value can never be
 * "Session" on one surface and "session_name" on another.
 */
export const TRADE_PRESENTATION_FIELD_SPECS: FieldSpec[] = [
  /* 1 — Trade overview */
  { key: "tradeId", label: "Trade ID", section: "overview", keys: ["id"], value: trade => tradeIdLabel(trade.id) },
  { key: "tradeDate", label: "Trade date", section: "overview", keys: ["tradeDate"], value: trade => presentationText(formatDate(trade.tradeDate as string | number | Date)), inHeader: true },
  { key: "symbol", label: "Symbol", section: "overview", keys: ["symbol"], value: trade => presentationText(trade.symbol), inHeader: true },
  { key: "session", label: "Session", section: "overview", keys: ["session"], value: trade => presentationText(trade.session), inHeader: true },
  { key: "direction", label: "Direction", section: "overview", keys: ["direction"], value: trade => presentationText(trade.direction), inHeader: true },
  { key: "result", label: "Result", section: "overview", keys: ["result"], value: trade => presentationText(presentationSafeText(trade.result).replace(/_/g, " ")), inHeader: true },
  { key: "openTime", label: "Open time", section: "overview", keys: ["openTime"], value: trade => formatPktDateTime(trade.openTime) },
  { key: "closeTime", label: "Close time", section: "overview", keys: ["closeTime"], value: trade => formatPktDateTime(trade.closeTime) },
  { key: "duration", label: "Trade duration", section: "overview", keys: [], value: trade => duration(trade) },

  /* 2 — Strategy */
  { key: "level", label: "Level / confluence", section: "strategy", keys: ["level"], value: trade => presentationText(trade.level), wide: true },
  { key: "timeframe", label: "Timeframe", section: "strategy", keys: ["timeframe"], value: trade => presentationText(trade.timeframe) },
  { key: "setupQuality", label: "Setup quality", section: "strategy", keys: ["setupQuality"], value: trade => presentationText(trade.setupQuality) },
  { key: "confirmation", label: "Confirmation signals", section: "strategy", keys: ["confirmationType"], value: trade => presentationText(trade.confirmationType), wide: true },

  /* 3 — Execution */
  { key: "executionType", label: "Execution type", section: "execution", keys: ["executionType"], value: trade => presentationText(trade.executionType) },
  { key: "marketCondition", label: "Market conditions", section: "execution", keys: ["marketCondition"], value: trade => presentationText(trade.marketCondition) },
  { key: "biasAlignment", label: "Direction vs bias", section: "execution", keys: ["biasAlignment"], value: trade => presentationText(trade.biasAlignment) },
  { key: "slPlacement", label: "SL placement", section: "execution", keys: ["slPlacement"], value: trade => presentationText(trade.slPlacement) },
  { key: "tpPlacement", label: "TP placement", section: "execution", keys: ["tpPlacement"], value: trade => presentationText(trade.tpPlacement) },
  { key: "holdQuality", label: "Hold quality", section: "execution", keys: ["holdQuality"], value: trade => presentationText(trade.holdQuality) },
  { key: "patienceScore", label: "Patience score", section: "execution", keys: ["patienceScore"], value: trade => (isBlank(trade.patienceScore) ? PRESENTATION_MISSING : `${presentationSafeText(trade.patienceScore)}/5`), kpi: true },

  /* 4 — Risk & performance */
  { key: "risk", label: "Planned risk", section: "risk", keys: ["risk"], value: trade => money(trade.risk), tone: "signed" },
  { key: "reward", label: "Planned reward", section: "risk", keys: ["reward"], value: trade => money(trade.reward), tone: "signed" },
  { key: "plannedRr", label: "Planned R:R", section: "risk", keys: ["risk", "reward"], value: trade => rr(trade.risk, trade.reward), tone: "accent", kpi: true },
  { key: "pnl", label: "Actual P&L", section: "risk", keys: ["pnl"], value: trade => money(trade.pnl), tone: "signed", kpi: true },
  { key: "actualR", label: "Actual R", section: "risk", keys: ["risk", "pnl"], value: trade => actualR(trade.risk, trade.pnl), tone: "signed", kpi: true },
  { key: "runningBalance", label: "Running balance", section: "risk", keys: ["runningBalance"], value: (_trade, context) => (context.runningBalance == null ? PRESENTATION_MISSING : formatMoney(context.runningBalance)), tone: "signed" },
  { key: "mfe", label: "MFE", section: "risk", keys: ["mfe"], value: trade => money(trade.mfe), tone: "signed" },
  { key: "mae", label: "MAE", section: "risk", keys: ["mae"], value: trade => money(trade.mae), tone: "signed" },

  /* 5 — Plan & discipline */
  { key: "planStatus", label: "Plan status", section: "discipline", keys: ["planStatus"], value: trade => presentationText(trade.planStatus) },
  { key: "plannedFlag", label: "Planned / unplanned", section: "discipline", keys: ["planStatus"], value: trade => (isBlank(trade.planStatus) ? PRESENTATION_MISSING : PLAN_STATUS_LABELS[presentationSafeText(trade.planStatus).toUpperCase()] ?? presentationSafeText(trade.planStatus)) },
  { key: "checklistCompletion", label: "Checklist completion", section: "discipline", keys: ["planChecklist"], value: trade => checklistCompletion(trade.planChecklist), kpi: true },
  { key: "ruleAdherence", label: "Rule adherence", section: "discipline", keys: [], value: (_trade, context) => (context.process.ruleAdherence == null ? PRESENTATION_MISSING : `${Math.round(context.process.ruleAdherence)}%`), kpi: true },
  { key: "processClassification", label: "Process classification", section: "discipline", keys: [], value: (_trade, context) => (context.classification.summary ? `${context.classification.label} — ${context.classification.summary}` : context.classification.label), tone: "accent", wide: true },
  { key: "processReview", label: "Process review", section: "discipline", keys: [], value: (_trade, context) => processReasons(context.process), wide: true },

  /* 6 — Mistakes & behaviour */
  { key: "mistakeTags", label: "Mistake / rule-break tags", section: "mistakes", keys: ["mistake"], value: trade => presentationText(trade.mistake), wide: true },
  { key: "analyticalMistakes", label: "Analytical mistakes", section: "mistakes", keys: ["mistake"], value: trade => mistakeTags(trade, { category: "ANALYTICAL" }), wide: true },
  { key: "executionMistakes", label: "Execution mistakes", section: "mistakes", keys: ["mistake"], value: trade => mistakeTags(trade, { category: "EXECUTION" }), wide: true },
  { key: "emotionalTriggers", label: "Emotional triggers", section: "mistakes", keys: ["mistake"], value: trade => mistakeTags(trade, { category: "EMOTIONAL" }), wide: true },
  { key: "environmentalFactors", label: "Environmental factors", section: "mistakes", keys: ["mistake"], value: trade => mistakeTags(trade, { category: "ENVIRONMENTAL" }), wide: true },

  /* 7 — Psychology */
  { key: "emotionBefore", label: "Before trade", section: "psychology", keys: ["emotionBefore"], value: trade => presentationText(trade.emotionBefore), wide: true },
  { key: "emotionDuring", label: "During trade", section: "psychology", keys: ["emotionDuring"], value: trade => presentationText(trade.emotionDuring), wide: true },
  { key: "emotionAfter", label: "After trade", section: "psychology", keys: ["emotionAfter"], value: trade => presentationText(trade.emotionAfter), wide: true },

  /* 8 — Journal */
  { key: "notes", label: "Trade notes", section: "journal", keys: ["notes"], value: trade => presentationText(trade.notes), wide: true },
];

/** The report's KPI strip, in presentation order. */
export const TRADE_PRESENTATION_KPI_KEYS = ["pnl", "actualR", "plannedRr", "ruleAdherence", "checklistCompletion", "patienceScore"] as const;

export const TRADE_PRESENTATION_SECTION_ORDER: TradePresentationSectionId[] = ["overview", "strategy", "execution", "risk", "discipline", "checklist", "mistakes", "psychology", "journal"];

/**
 * The fields the Edit Trade form writes. If the form gains a field, this list
 * gains it too, and the completeness test fails until the presentation model maps
 * it — which is exactly the guard that stops the next silent export gap.
 */
export const EDITABLE_TRADE_FIELDS: Array<{ key: string; label: string }> = [
  { key: "tradeDate", label: "Date" },
  { key: "session", label: "Session" },
  { key: "direction", label: "Direction" },
  { key: "result", label: "Result" },
  { key: "level", label: "Level / confluence" },
  { key: "timeframe", label: "Timeframe" },
  { key: "setupQuality", label: "Setup quality" },
  { key: "confirmationType", label: "Confirmation signals" },
  { key: "executionType", label: "Execution type" },
  { key: "marketCondition", label: "Market conditions" },
  { key: "biasAlignment", label: "Direction vs bias" },
  { key: "slPlacement", label: "SL placement" },
  { key: "tpPlacement", label: "TP placement" },
  { key: "holdQuality", label: "Hold quality" },
  { key: "patienceScore", label: "Patience score" },
  { key: "mistake", label: "Mistake / rule-break tags" },
  { key: "risk", label: "Planned risk" },
  { key: "reward", label: "Planned reward" },
  { key: "pnl", label: "Actual P&L" },
  { key: "planStatus", label: "Plan link" },
  { key: "planChecklist", label: "Pre-trade checklist" },
  { key: "notes", label: "Trade notes" },
  { key: "emotionBefore", label: "Emotion before" },
  { key: "emotionDuring", label: "Emotion during" },
  { key: "emotionAfter", label: "Emotion after" },
  { key: "screenshot", label: "Screenshot evidence" },
];

/** Persisted keys the presentation model reads, derived or stored. */
export const TRADE_PRESENTATION_SOURCE_KEYS: string[] = Array.from(new Set([
  ...TRADE_PRESENTATION_FIELD_SPECS.flatMap(spec => spec.keys),
  ...TRADE_PRESENTATION_FIELD_SPECS.map(spec => spec.key),
  "planChecklist", "screenshotUrl", "hasScreenshot", "screenshot",
]));

/**
 * Plumbing that never reaches a trader: MT5 sync identifiers, storage keys and
 * filenames, owner/account ids, audit timestamps, and local sync markers.
 * `mt5Ticket` and `screenshotName` live here deliberately — they are sync and
 * storage metadata, not part of the trade review.
 */
export const TRADE_INTERNAL_KEYS = [
  "userId", "accountId", "createdAt", "updatedAt", "screenshotKey", "screenshotName",
  "clientMutationId", "localPending", "mt5Ticket", "mt5PositionId", "mt5Deal", "syncState",
];

/** Every distinct presentation field key, for the completeness contract. */
export const CANONICAL_TRADE_PRESENTATION_FIELDS: string[] = TRADE_PRESENTATION_FIELD_SPECS.map(spec => spec.key);

/** The exact user-facing labels every surface prints, in canonical order. */
export const TRADE_PRESENTATION_LABELS: string[] = TRADE_PRESENTATION_FIELD_SPECS.map(spec => spec.label);

export function presentationFieldByKey(key: string): FieldSpec | null {
  return TRADE_PRESENTATION_FIELD_SPECS.find(spec => spec.key === key) ?? null;
}

/* ------------------------------------------------------------------ *
 * Additional (unmapped) fields
 * ------------------------------------------------------------------ */

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
  return presentationSafeText(value);
}

/**
 * Everything the trade record carries that the canonical sections do not already
 * show. A future column therefore appears automatically instead of being
 * forgotten, while internal plumbing stays out.
 */
export function additionalTradeFields(trade: PresentationTrade): TradePresentationField[] {
  const mapped = new Set([...TRADE_PRESENTATION_SOURCE_KEYS, ...TRADE_INTERNAL_KEYS, "id", "symbol"]);
  const fields: TradePresentationField[] = [];
  for (const key of Object.keys(trade).sort()) {
    if (mapped.has(key)) continue;
    const value = additionalValue(trade[key]);
    if (value == null) continue;
    fields.push({ key: `additional:${key}`, label: key, value });
  }
  return fields;
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

/**
 * Builds the complete user-facing representation of one trade. This is the single
 * model View Trade, the Share Trade Card, and the PDF report all render.
 */
export function buildTradePresentation(trade: PresentationTrade, options: TradePresentationOptions = {}): TradePresentation {
  const process = classifyTradeProcess(trade as Parameters<typeof classifyTradeProcess>[0]);
  const classification = classificationFor(process);
  const context: PresentationContext = { runningBalance: options.runningBalance ?? null, process, classification };
  const sections: TradePresentationSection[] = TRADE_PRESENTATION_SECTION_ORDER.map(id => ({
    id,
    title: TRADE_SECTION_THEME[id].title,
    accent: TRADE_SECTION_THEME[id].accent,
    fields: TRADE_PRESENTATION_FIELD_SPECS.filter(spec => spec.section === id).map(spec => ({
      key: spec.key,
      label: spec.label,
      value: spec.value(trade, context),
      wide: spec.wide,
      tone: spec.tone,
      kpi: spec.kpi,
      inHeader: spec.inHeader,
    })),
  }));
  const byKey = new Map(sections.flatMap(section => section.fields).map(field => [field.key, field]));
  const kpis: TradePresentationKpi[] = TRADE_PRESENTATION_KPI_KEYS
    .map(key => byKey.get(key))
    .filter((field): field is TradePresentationField => Boolean(field))
    .map(field => ({ key: field.key, label: field.label, value: field.value, tone: resolveTone(field) }));
  const result = presentationSafeText(trade.result);
  const tradeDate = formatDate(trade.tradeDate as string | number | Date);
  const symbol = presentationText(trade.symbol);
  const session = presentationText(trade.session);
  const direction = presentationText(trade.direction);
  const resultLabel = result.trim() === "" ? PRESENTATION_MISSING : result.replace(/_/g, " ");
  return {
    id: (trade.id ?? null) as number | string | null,
    identity: {
      idLabel: tradeIdLabel(trade.id),
      tradeDate,
      symbol,
      session,
      direction,
      result: resultLabel,
      pnl: money(trade.pnl),
      pnlValue: toNumber(trade.pnl),
      line: [tradeDate, symbol, session, direction, resultLabel].filter(value => value !== PRESENTATION_MISSING).join(" · ").toUpperCase(),
    },
    kpis,
    sections,
    checklist: checklistItems(trade.planChecklist),
    classification,
    psychology: {
      before: presentationSafeText(trade.emotionBefore),
      during: presentationSafeText(trade.emotionDuring),
      after: presentationSafeText(trade.emotionAfter),
    },
    journalNotes: presentationSafeText(trade.notes),
    evidence: {
      url: isBlank(trade.screenshotUrl) ? null : presentationSafeText(trade.screenshotUrl),
      hasScreenshot: Boolean(trade.hasScreenshot) || !isBlank(trade.screenshotKey) || !isBlank(trade.screenshotUrl),
    },
    additionalFields: additionalTradeFields(trade),
  };
}

/** Flat `label -> value` view of the model, used by tests and copy-friendly views. */
export function presentationValues(model: TradePresentation): Record<string, string> {
  const values: Record<string, string> = {};
  for (const section of model.sections) for (const field of section.fields) values[field.label] = field.value;
  return values;
}

/** The fields of one canonical section, in order. */
export function sectionFields(model: TradePresentation, id: TradePresentationSectionId): TradePresentationField[] {
  return model.sections.find(section => section.id === id)?.fields ?? [];
}
