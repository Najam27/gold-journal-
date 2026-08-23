import { formatDate, formatMoney, formatRr, toNumber } from "./gold";

type TradeCardField = readonly [label: string, value: string];
type TradeCard = Record<string, unknown> & { tradeDate: Date | string | number; direction?: string; result?: string; pnl?: string | number | null; screenshotUrl?: string | null };

const CARD_BACKGROUND = "#10141a";
const CARD_PANEL = "#192029";
const CARD_TEXT = "#eef3f7";
const CARD_MUTED = "#9ca9b7";
const CARD_GOLD = "#e9b64b";

function safeText(value: unknown, max = 800) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
}

function safeFilename(value: unknown) {
  return safeText(value, 80).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "trade";
}

export function publicTradeCardFields(trade: TradeCard): TradeCardField[] {
  return [
    ["Trade date", formatDate(trade.tradeDate)], ["Session", safeText(trade.session) || "—"], ["Direction", safeText(trade.direction) || "—"], ["Result", safeText(trade.result).replace(/_/g, " ") || "—"],
    ["Level", safeText(trade.level) || "—"], ["Timeframe", safeText(trade.timeframe) || "—"], ["Setup", safeText(trade.setupQuality) || "—"], ["Confirmation", safeText(trade.confirmationType) || "—"],
    ["Execution", safeText(trade.executionType) || "—"], ["Market condition", safeText(trade.marketCondition) || "—"], ["Bias alignment", safeText(trade.biasAlignment) || "—"], ["SL placement", safeText(trade.slPlacement) || "—"],
    ["TP placement", safeText(trade.tpPlacement) || "—"], ["Mistake", safeText(trade.mistake) || "—"], ["Hold quality", safeText(trade.holdQuality) || "—"], ["Patience", trade.patienceScore ? `${safeText(trade.patienceScore)}/5` : "—"],
    ["Risk", formatMoney(trade.risk as string | number | null)], ["Reward", formatMoney(trade.reward as string | number | null)], ["Planned R:R", formatRr(trade.risk as string | number | null, trade.reward as string | number | null)], ["P&L", formatMoney(trade.pnl as string | number | null)],
  ];
}

export function tradeCardPngFilename(trade: TradeCard) {
  return `GoldJournal_TradeCard_${safeFilename(formatDate(trade.tradeDate))}_${safeFilename(trade.direction)}_${safeFilename(trade.result)}.png`;
}

function textElement(tag: string, text: string, style: Partial<CSSStyleDeclaration> = {}) {
  const element = document.createElement(tag);
  element.textContent = text;
  Object.assign(element.style, style);
  return element;
}

async function screenshotDataUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Screenshot evidence could not be loaded.");
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
}

async function createCardNode(trade: TradeCard) {
  const card = document.createElement("article");
  Object.assign(card.style, { width: "1080px", boxSizing: "border-box", padding: "48px", color: CARD_TEXT, background: CARD_BACKGROUND, fontFamily: "Inter, Arial, sans-serif", lineHeight: "1.35", borderRadius: "24px" });
  const eyebrow = textElement("div", "GOLD JOURNAL · PRIVATE TRADE CARD", { color: CARD_GOLD, fontSize: "15px", fontWeight: "800", letterSpacing: "1.8px" });
  const title = textElement("h1", `${formatDate(trade.tradeDate)} · ${safeText(trade.direction) || "—"} · ${safeText(trade.result).replace(/_/g, " ") || "—"}`, { margin: "10px 0 24px", fontSize: "38px", lineHeight: "1.12" });
  const pnl = toNumber(trade.pnl as string | number | null);
  const pnlBand = textElement("div", `P&L  ${formatMoney(trade.pnl as string | number | null)}`, { padding: "18px 22px", color: pnl >= 0 ? "#78dcad" : "#ff958e", background: pnl >= 0 ? "#143d32" : "#4a2527", borderRadius: "14px", fontSize: "27px", fontWeight: "800", fontVariantNumeric: "tabular-nums" });
  const grid = document.createElement("div");
  Object.assign(grid.style, { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "12px", marginTop: "24px" });
  for (const [label, value] of publicTradeCardFields(trade)) {
    const field = document.createElement("div");
    Object.assign(field.style, { minHeight: "76px", padding: "13px", background: CARD_PANEL, border: "1px solid #2a3542", borderRadius: "12px" });
    field.append(textElement("div", label.toUpperCase(), { color: CARD_MUTED, fontSize: "11px", fontWeight: "800", letterSpacing: "1px" }), textElement("div", value, { marginTop: "7px", fontSize: "16px", fontWeight: "650", overflowWrap: "anywhere" }));
    grid.append(field);
  }
  card.append(eyebrow, title, pnlBand, grid);

  const noteEntries: Array<[string, unknown]> = [["Emotion before", trade.emotionBefore], ["Emotion during", trade.emotionDuring], ["Emotion after", trade.emotionAfter], ["Journal notes", trade.notes]];
  if (noteEntries.some(([, value]) => safeText(value))) {
    const notes = document.createElement("section"); Object.assign(notes.style, { marginTop: "24px", padding: "18px", background: CARD_PANEL, border: "1px solid #2a3542", borderRadius: "14px" });
    notes.append(textElement("div", "EXECUTION JOURNAL", { color: CARD_GOLD, fontSize: "12px", fontWeight: "800", letterSpacing: "1.2px" }));
    for (const [label, value] of noteEntries) { const text = safeText(value, 2000); if (text) { const row = textElement("p", `${label}: ${text}`, { margin: "10px 0 0", color: CARD_TEXT, fontSize: "15px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }); notes.append(row); } }
    card.append(notes);
  }
  if (trade.screenshotUrl) {
    const evidence = document.createElement("section"); Object.assign(evidence.style, { marginTop: "24px", padding: "18px", background: CARD_PANEL, border: "1px solid #2a3542", borderRadius: "14px" });
    evidence.append(textElement("div", "SCREENSHOT EVIDENCE", { color: CARD_GOLD, fontSize: "12px", fontWeight: "800", letterSpacing: "1.2px" }));
    try { const image = document.createElement("img"); image.src = await screenshotDataUrl(String(trade.screenshotUrl)); image.alt = "Attached trade screenshot"; Object.assign(image.style, { display: "block", width: "100%", maxHeight: "960px", marginTop: "13px", objectFit: "contain", background: "#0b0f14", borderRadius: "10px" }); evidence.append(image); } catch { evidence.append(textElement("p", "Screenshot evidence could not be included at export time.", { margin: "12px 0 0", color: CARD_MUTED, fontSize: "14px" })); }
    card.append(evidence);
  }
  card.append(textElement("footer", "Generated from your private Gold Journal · shared image contains no account IDs, owner IDs, storage keys, signed URLs, or internal timestamps.", { display: "block", marginTop: "24px", color: CARD_MUTED, fontSize: "12px" }));
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
