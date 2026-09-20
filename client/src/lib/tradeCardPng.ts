/**
 * The shareable Trade Card image.
 *
 * The card renders the *same* canonical Trade Presentation Model as the viewer and
 * the PDF report — `buildTradePresentation` — so the image a trader shares carries
 * exactly the trade information the app shows. It re-lays the model out (smaller
 * type, compact grids, section bands) rather than copying the on-screen UI, and it
 * never adds anything: MT5 ticket numbers, storage keys, file names, owner/account
 * ids, and internal timestamps are not in the model at all.
 */

import {
  PRESENTATION_MISSING,
  TRADE_EVIDENCE_THEME,
  TRADE_SECTION_THEME,
  buildTradePresentation,
  resolveTone,
  type TradePresentation,
  type TradePresentationField,
  type TradeTone,
} from "./tradePresentation";
import { formatDate } from "./gold";

type TradeCard = Record<string, unknown> & { tradeDate?: Date | string | number; direction?: string; result?: string; screenshotUrl?: string | null };

const CARD_BACKGROUND = "#0f141a";
const CARD_PANEL = "#171e26";
const CARD_TEXT = "#eef3f7";
const CARD_MUTED = "#9ca9b7";
const CARD_LINE = "#2a3542";
const CARD_GOLD = "#e9b64b";

const TONE_COLORS: Record<TradeTone, string> = {
  neutral: CARD_TEXT,
  signed: CARD_TEXT,
  positive: "#78dcad",
  negative: "#ff958e",
  accent: CARD_GOLD,
  warning: "#f0b357",
};

function safeText(value: unknown, max = 4000) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
}

function safeFilename(value: unknown) {
  return safeText(value, 80).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "trade";
}

/**
 * Every canonical user-facing field of the trade as `[label, value]` pairs.
 * Kept for the share pipeline's contract test: it is derived from the canonical
 * model, never hand-listed.
 */
export function publicTradeCardFields(trade: TradeCard) {
  const model = buildTradePresentation(trade);
  return model.sections.flatMap(section => section.fields.map(field => [field.label, field.value] as const));
}

export function tradeCardPngFilename(trade: TradeCard) {
  return `GoldJournal_TradeCard_${safeFilename(formatDate(trade.tradeDate as never))}_${safeFilename(trade.direction)}_${safeFilename(trade.result)}.png`;
}

function textElement(tag: string, text: string, style: Partial<CSSStyleDeclaration> = {}) {
  const element = document.createElement(tag);
  element.textContent = text;
  Object.assign(element.style, style);
  return element;
}

async function screenshotDataUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Trade evidence could not be loaded.");
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
}

function band(title: string, accent: string) {
  return textElement("div", title.toUpperCase(), {
    padding: "6px 10px", background: accent, color: "#ffffff", fontSize: "12px", fontWeight: "800", letterSpacing: "1.1px",
  });
}

function fieldGrid(fields: TradePresentationField[]) {
  const grid = document.createElement("div");
  Object.assign(grid.style, { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "1px", background: CARD_LINE });
  for (const field of fields.filter(entry => !entry.inHeader)) {
    const cell = document.createElement("div");
    Object.assign(cell.style, { padding: "8px 10px", background: CARD_PANEL });
    const tone = resolveTone(field);
    cell.append(
      textElement("div", field.label.toUpperCase(), { color: CARD_MUTED, fontSize: "10px", fontWeight: "800", letterSpacing: "0.9px" }),
      textElement("div", field.value, { marginTop: "4px", color: TONE_COLORS[tone], fontSize: "14px", fontWeight: "600", overflowWrap: "anywhere", whiteSpace: "pre-wrap" }),
    );
    grid.append(cell);
  }
  return grid;
}

function section(model: TradePresentation, id: string) {
  const found = model.sections.find(entry => entry.id === id);
  if (!found) return null;
  const wrapper = document.createElement("section");
  Object.assign(wrapper.style, { marginTop: "14px", border: `1px solid ${CARD_LINE}`, borderRadius: "10px", overflow: "hidden" });
  wrapper.append(band(found.title, found.accent), fieldGrid(found.fields));
  return wrapper;
}

async function createCardNode(trade: TradeCard) {
  const model = buildTradePresentation(trade);
  const card = document.createElement("article");
  Object.assign(card.style, { width: "1080px", boxSizing: "border-box", padding: "40px", color: CARD_TEXT, background: CARD_BACKGROUND, fontFamily: "Inter, Arial, sans-serif", lineHeight: "1.35" });

  const header = document.createElement("header");
  Object.assign(header.style, { padding: "18px 20px", border: `1px solid ${CARD_LINE}`, borderRadius: "14px", background: CARD_PANEL });
  header.append(
    textElement("div", "GOLD JOURNAL · PRIVATE TRADE CARD", { color: CARD_GOLD, fontSize: "13px", fontWeight: "800", letterSpacing: "1.8px" }),
    textElement("h1", model.identity.line || PRESENTATION_MISSING, { margin: "10px 0 0", fontSize: "30px", lineHeight: "1.15" }),
    textElement("div", `${model.identity.pnl}  ·  actual`, {
      marginTop: "12px", padding: "10px 14px", borderRadius: "10px", fontSize: "22px", fontWeight: "800",
      color: model.identity.pnlValue >= 0 ? TONE_COLORS.positive : TONE_COLORS.negative,
      background: model.identity.pnlValue >= 0 ? "#143d32" : "#4a2527",
      fontVariantNumeric: "tabular-nums",
    }),
  );

  const kpis = document.createElement("div");
  Object.assign(kpis.style, { display: "grid", gridTemplateColumns: `repeat(${Math.max(1, model.kpis.length)}, minmax(0, 1fr))`, gap: "8px", marginTop: "14px" });
  for (const kpi of model.kpis) {
    const tile = document.createElement("div");
    Object.assign(tile.style, { padding: "9px 11px", border: `1px solid ${CARD_LINE}`, borderRadius: "10px", background: CARD_PANEL });
    tile.append(
      textElement("div", kpi.label.toUpperCase(), { color: CARD_MUTED, fontSize: "10px", fontWeight: "800", letterSpacing: "0.9px" }),
      textElement("div", kpi.value, { marginTop: "5px", color: TONE_COLORS[kpi.tone], fontSize: "17px", fontWeight: "800", fontVariantNumeric: "tabular-nums" }),
    );
    kpis.append(tile);
  }

  card.append(header, kpis);
  for (const id of ["overview", "strategy", "execution", "risk", "discipline"]) {
    const block = section(model, id);
    if (block) card.append(block);
  }

  // The process verdict sits beside the discipline fields, never behind the P&L.
  const process = document.createElement("section");
  Object.assign(process.style, { marginTop: "14px", border: `1px solid ${CARD_LINE}`, borderRadius: "10px", overflow: "hidden" });
  process.append(band(model.sections.find(entry => entry.id === "discipline")?.fields.find(field => field.key === "processClassification")?.label ?? TRADE_SECTION_THEME.discipline.title, model.sections.find(entry => entry.id === "discipline")?.accent ?? CARD_GOLD));
  const processBody = document.createElement("div");
  Object.assign(processBody.style, { padding: "12px", background: CARD_PANEL });
  processBody.append(
    textElement("div", model.classification.label.toUpperCase(), { color: TONE_COLORS[model.classification.tone], fontSize: "16px", fontWeight: "800", letterSpacing: "0.8px" }),
    textElement("p", model.classification.summary || PRESENTATION_MISSING, { margin: "8px 0 0", color: CARD_MUTED, fontSize: "13px", lineHeight: "1.5" }),
  );
  const review = model.sections.find(entry => entry.id === "discipline")?.fields.find(field => field.key === "processReview");
  if (review && review.value !== PRESENTATION_MISSING) processBody.append(textElement("p", review.value, { margin: "8px 0 0", color: CARD_TEXT, fontSize: "13px", lineHeight: "1.55", whiteSpace: "pre-wrap" }));
  process.append(processBody);
  card.append(process);

  const checklist = document.createElement("section");
  Object.assign(checklist.style, { marginTop: "14px", border: `1px solid ${CARD_LINE}`, borderRadius: "10px", overflow: "hidden" });
  checklist.append(band(TRADE_SECTION_THEME.checklist.title, TRADE_SECTION_THEME.checklist.accent));
  const checklistBody = document.createElement("div");
  Object.assign(checklistBody.style, { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "6px 16px", padding: "12px", background: CARD_PANEL });
  for (const item of model.checklist) {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "8px", color: item.confirmed ? CARD_TEXT : CARD_MUTED, fontSize: "13px" });
    row.append(
      textElement("b", item.confirmed ? "✓" : "✗", { color: item.confirmed ? TONE_COLORS.positive : item.recorded ? TONE_COLORS.negative : CARD_MUTED, fontWeight: "800" }),
      textElement("span", item.label),
    );
    checklistBody.append(row);
  }
  checklist.append(checklistBody);
  card.append(checklist);

  const mistakes = section(model, "mistakes");
  if (mistakes) card.append(mistakes);

  const psychology = document.createElement("section");
  const psychologyFields = model.sections.find(entry => entry.id === "psychology")?.fields ?? [];
  Object.assign(psychology.style, { marginTop: "14px", border: `1px solid ${CARD_LINE}`, borderRadius: "10px", overflow: "hidden" });
  psychology.append(band(TRADE_SECTION_THEME.psychology.title, TRADE_SECTION_THEME.psychology.accent));
  const psychologyBody = document.createElement("div");
  Object.assign(psychologyBody.style, { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "1px", background: CARD_LINE });
  for (const [label, value] of [
    // Labels and values both come from the canonical model, so the shared image
    // can never drift from the viewer.
    [psychologyFields[0]?.label, model.psychology.before],
    [psychologyFields[1]?.label, model.psychology.during],
    [psychologyFields[2]?.label, model.psychology.after],
  ] as const) {
    const cell = document.createElement("div");
    Object.assign(cell.style, { padding: "11px 12px", background: CARD_PANEL });
    cell.append(
      textElement("div", (label ?? TRADE_SECTION_THEME.psychology.title).toUpperCase(), { color: CARD_MUTED, fontSize: "10px", fontWeight: "800", letterSpacing: "0.9px" }),
      textElement("div", value.trim() === "" ? PRESENTATION_MISSING : value, { marginTop: "6px", fontSize: "13px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }),
    );
    psychologyBody.append(cell);
  }
  psychology.append(psychologyBody);
  card.append(psychology);

  const journal = document.createElement("section");
  Object.assign(journal.style, { marginTop: "14px", border: `1px solid ${CARD_LINE}`, borderRadius: "10px", overflow: "hidden" });
  journal.append(band(TRADE_SECTION_THEME.journal.title, TRADE_SECTION_THEME.journal.accent));
  const journalBody = document.createElement("div");
  Object.assign(journalBody.style, { padding: "12px", background: CARD_PANEL, fontSize: "13px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" });
  journalBody.textContent = model.journalNotes.trim() ? model.journalNotes : PRESENTATION_MISSING;
  journal.append(journalBody);
  card.append(journal);

  if (model.evidence.url) {
    const evidence = document.createElement("section");
    Object.assign(evidence.style, { marginTop: "14px", border: `1px solid ${CARD_LINE}`, borderRadius: "10px", overflow: "hidden" });
    evidence.append(band(TRADE_EVIDENCE_THEME.title, TRADE_EVIDENCE_THEME.accent));
    const holder = document.createElement("div");
    Object.assign(holder.style, { padding: "12px", background: CARD_PANEL });
    try {
      const image = document.createElement("img");
      image.src = await screenshotDataUrl(model.evidence.url);
      image.alt = "Attached trade screenshot";
      Object.assign(image.style, { display: "block", width: "100%", maxHeight: "960px", objectFit: "contain", background: "#0b0f14", borderRadius: "10px" });
      holder.append(image);
    } catch {
      holder.append(textElement("p", "The screenshot could not be included at export time.", { margin: "0", color: CARD_MUTED, fontSize: "13px" }));
    }
    evidence.append(holder);
    card.append(evidence);
  }

  card.append(textElement("footer", "Generated from your private Gold Journal · the shared image contains no account ids, owner ids, storage keys, signed urls, file names, or internal timestamps.", { display: "block", marginTop: "20px", color: CARD_MUTED, fontSize: "11px" }));
  return card;
}

export async function createTradeCardPng(trade: TradeCard) {
  if (typeof document === "undefined") throw new Error("Trade-card images can only be created in a browser.");
  const host = document.createElement("div"); Object.assign(host.style, { position: "fixed", left: "-12000px", top: "0", zIndex: "-1", pointerEvents: "none" });
  const card = await createCardNode(trade); host.append(card); document.body.append(host);
  try {
    const { default: html2canvas } = await import("html2canvas");
    const canvas = await html2canvas(card, { backgroundColor: CARD_BACKGROUND, scale: 2, useCORS: true, logging: false });
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Trade-card image could not be created.");
    return { blob, filename: tradeCardPngFilename(trade) };
  } finally { host.remove(); }
}

export function downloadTradeCardPng(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.style.display = "none"; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function copyTradeCardPng(blob: Blob) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

export async function shareTradeCardPng(blob: Blob, filename: string) {
  if (typeof navigator === "undefined" || typeof File === "undefined" || !navigator.share) return false;
  const file = new File([blob], filename, { type: "image/png" }); const payload = { files: [file], title: "Gold Journal Trade Card", text: "Private Gold Journal trade card" };
  if (navigator.canShare && !navigator.canShare(payload)) return false;
  await navigator.share(payload); return true;
}
