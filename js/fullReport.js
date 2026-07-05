// Bulk "Full Report" PDF export: one page per trade with its screenshot.
// Screenshots are fetched in batches so we never hold every image in memory at
// once, each image is embedded and then released before the next is loaded.
// A screenshot that fails or times out is replaced by a placeholder and never
// aborts the run.
import { openModal } from "./modal.js";
import { toast, fmtMoney, fmtDate, fmtRR } from "./ui.js";
import { state, tradeRunningBalance, currentAccount, signedUrl } from "./store.js";

const JSPDF_CDN = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
const BATCH_SIZE = 10;
const SECONDS_PER_TRADE = 3;
const SCREENSHOT_TIMEOUT_MS = 8000;
const LOW_QUALITY_MAX_WIDTH = 800;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

function estimateText(count) {
  const secs = count * SECONDS_PER_TRADE;
  if (secs < 60) return "less than a minute";
  const mins = Math.round(secs / 60);
  return `${mins} minute${mins === 1 ? "" : "s"}`;
}

function sanitize(name) {
  return String(name || "Account").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "Account";
}

// ---------- entry point ----------
export function openFullReport() {
  const trades = [...state.trades]; // chronological (store keeps ascending order)
  if (!trades.length) return toast("No trades to export.", "warning");

  const acc = currentAccount();
  const withShots = trades.filter((t) => t.screenshot_path).length;
  const dates = trades.map((t) => t.trade_date).filter(Boolean).sort();
  const from = dates[0] || "";
  const to = dates[dates.length - 1] || "";

  const bodyHtml = `
    <div class="fr-warn">
      <p class="fr-lead">You are exporting <strong>${trades.length}</strong> trade${trades.length === 1 ? "" : "s"}${withShots ? ` (<strong>${withShots}</strong> with screenshots)` : ""}.</p>
      <p class="fr-est">Estimated time: <strong id="fr-est">${estimateText(trades.length)}</strong>.</p>
      <p class="fr-keepopen"><i data-lucide="alert-triangle"></i> Keep this tab open and do not close it while the export runs.</p>
      <label class="fr-toggle">
        <span>
          <span class="fr-toggle-title">Low Quality Mode</span>
          <span class="fr-toggle-sub">Compress screenshots to ${LOW_QUALITY_MAX_WIDTH}px wide — smaller file, faster.</span>
        </span>
        <input type="checkbox" id="fr-lowq" checked>
      </label>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" id="fr-cancel">Cancel</button>
        <button type="button" class="btn btn-gold" id="fr-start"><i data-lucide="download"></i> Start Export</button>
      </div>
    </div>`;

  const m = openModal({ title: "Download Full Report PDF", bodyHtml });
  m.body.querySelector("#fr-cancel").addEventListener("click", m.close);
  m.body.querySelector("#fr-start").addEventListener("click", () => {
    const lowQuality = m.body.querySelector("#fr-lowq").checked;
    m.close();
    runExport(trades, { acc, from, to, lowQuality }).catch((e) => {
      console.error(e);
      toast(e?.message ? `Export failed: ${e.message}` : "Export failed.", "error");
    });
  });
}

// ---------- progress modal ----------
function openProgress(total) {
  const bodyHtml = `
    <div class="fr-progress">
      <p class="fr-status" id="fr-status">Preparing…</p>
      <div class="progress"><span id="fr-bar" style="width:0%"></span></div>
      <p class="fr-hint">Keep this tab open until the download starts.</p>
    </div>`;
  const m = openModal({ title: "Generating PDF", bodyHtml });
  // Hide the close button — export shouldn't be dismissed mid-run.
  m.el.querySelector(".gj-modal-x")?.remove();
  const statusEl = m.body.querySelector("#fr-status");
  const barEl = m.body.querySelector("#fr-bar");
  return {
    close: m.close,
    set(done, label) {
      statusEl.textContent = label || `Processing trade ${done} of ${total}…`;
      barEl.style.width = `${Math.round((done / total) * 100)}%`;
    },
  };
}

// Yield to the event loop so the progress bar actually repaints.
const paint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------- image loading ----------
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }).catch(() => { clearTimeout(timer); resolve(null); });
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load error"));
    img.src = url;
  });
}

// Returns { dataUrl, w, h } or null. Draws through a canvas so we control
// format/size; low-quality mode caps width for a smaller, faster file.
async function fetchScreenshot(path, lowQuality) {
  if (!path) return null;
  return withTimeout((async () => {
    const url = await signedUrl(path);
    if (!url) return null;
    const img = await loadImage(url);
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    if (lowQuality && w > LOW_QUALITY_MAX_WIDTH) {
      h = Math.round(h * (LOW_QUALITY_MAX_WIDTH / w));
      w = LOW_QUALITY_MAX_WIDTH;
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", lowQuality ? 0.7 : 0.92);
    return { dataUrl, w, h };
  })(), SCREENSHOT_TIMEOUT_MS);
}

// ---------- PDF drawing ----------
const GOLD = [212, 175, 55];
const INK = [30, 30, 30];
const MUTED = [110, 110, 110];
const M = 14; // page margin (mm)

function resultColor(result) {
  if (result === "Win") return [22, 163, 74];
  if (result === "Loss") return [220, 38, 38];
  return [107, 114, 128]; // Break-even / Open / none
}

function drawCover(doc, { acc, from, to, trades }) {
  const pw = doc.internal.pageSize.getWidth();
  const wins = trades.filter((t) => t.result === "Win").length;
  const losses = trades.filter((t) => t.result === "Loss").length;
  const decided = wins + losses;
  const totalPnl = trades.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const winRate = decided ? ((wins / decided) * 100).toFixed(1) : "0.0";

  doc.setFont("helvetica", "bold");
  doc.setFontSize(40);
  doc.setTextColor(...GOLD);
  doc.text("Gold Journal", pw / 2, 95, { align: "center" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(16);
  doc.setTextColor(...INK);
  doc.text(acc?.name || "Account", pw / 2, 112, { align: "center" });

  doc.setFontSize(11);
  doc.setTextColor(...MUTED);
  doc.text(`Export range: ${from ? fmtDate(from) : "All"} — ${to ? fmtDate(to) : "All"}`, pw / 2, 124, { align: "center" });
  doc.text(`Total trades: ${trades.length}`, pw / 2, 132, { align: "center" });

  // summary box
  const boxW = 150, boxX = (pw - boxW) / 2, boxY = 150;
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.4);
  doc.roundedRect(boxX, boxY, boxW, 56, 3, 3);
  doc.setFontSize(12);
  doc.setTextColor(...INK);
  doc.setFont("helvetica", "bold");
  doc.text("Summary", boxX + 8, boxY + 12);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  const line = (label, value, y) => {
    doc.setTextColor(...MUTED);
    doc.text(label, boxX + 8, y);
    doc.setTextColor(...INK);
    doc.text(String(value), boxX + boxW - 8, y, { align: "right" });
  };
  line("Total P&L", fmtMoney(totalPnl), boxY + 24);
  line("Win Rate", `${winRate}%`, boxY + 33);
  line("Total Wins", String(wins), boxY + 42);
  line("Total Losses", String(losses), boxY + 51);

  drawFooter(doc);
}

function drawFooter(doc) {
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  doc.setDrawColor(210);
  doc.setLineWidth(0.2);
  doc.line(M, ph - 14, pw - M, ph - 14);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(`Gold Journal  |  Exported on ${fmtDate(new Date())}`, pw / 2, ph - 9, { align: "center" });
}

function drawTopBar(doc, t, index) {
  const pw = doc.internal.pageSize.getWidth();
  const barW = pw - M * 2;
  doc.setFillColor(26, 32, 44);
  doc.roundedRect(M, M, barW, 12, 2, 2, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...GOLD);
  const left = `#${index}   ${fmtDate(t.trade_date)}   ${t.session || "—"}   ${t.side || "—"}`;
  doc.text(left, M + 4, M + 8);

  // result badge (right-aligned inside the bar)
  const label = t.result || "—";
  doc.setFontSize(9);
  const padX = 3;
  const textW = doc.getTextWidth(label);
  const badgeW = textW + padX * 2;
  const badgeX = pw - M - 4 - badgeW;
  doc.setFillColor(...resultColor(t.result));
  doc.roundedRect(badgeX, M + 2.5, badgeW, 7, 1.5, 1.5, "F");
  doc.setTextColor(255, 255, 255);
  doc.text(label, badgeX + padX, M + 7.4);
}

function drawTradePage(doc, t, index) {
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  drawTopBar(doc, t, index);

  const top = M + 20;
  const leftX = M;
  const leftW = 78;
  const rightX = M + leftW + 8;
  const rightW = pw - M - rightX;

  // ----- LEFT COLUMN -----
  let y = top;
  const rr = fmtRR(t.risk_amount, t.reward_amount);
  const section = (title) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...GOLD);
    doc.text(title, leftX, y);
    y += 5.5;
  };
  const kv = (k, v) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    doc.text(String(k), leftX, y);
    doc.setTextColor(...INK);
    const val = doc.splitTextToSize(String(v ?? "—"), leftW - 34);
    doc.text(val, leftX + 34, y);
    y += 4.6 * val.length;
  };

  section("Trade Details");
  kv("Level", t.level);
  kv("Timeframe", t.timeframe);
  kv("Setup Quality", t.setup_quality);
  kv("Confirmation", t.confirmation_type);
  y += 2;
  section("Execution");
  kv("Market", t.market_condition);
  kv("Bias", t.bias_alignment);
  kv("SL Placement", t.sl_placement);
  kv("TP Placement", t.tp_placement);
  kv("Hold Quality", t.hold_quality);
  kv("Mistake", t.mistake);
  kv("Patience", t.patience_score ?? "—");
  y += 2;
  section("Risk & Reward");
  kv("Risk $", fmtMoney(t.risk_amount));
  kv("Reward $", fmtMoney(t.reward_amount));
  kv("R:R", rr);
  kv("P&L", fmtMoney(t.pnl));
  kv("Running Bal.", fmtMoney(tradeRunningBalance(t.id)));
  y += 2;
  section("Notes");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...INK);
  const notes = doc.splitTextToSize(t.notes || "—", leftW);
  doc.text(notes, leftX, y);

  // ----- RIGHT COLUMN (screenshot) -----
  const imgTop = top;
  const maxImgH = ph - imgTop - 24;
  const shot = t.__shot; // attached by runExport
  if (shot) {
    let dw = rightW;
    let dh = dw * (shot.h / shot.w);
    if (dh > maxImgH) { dh = maxImgH; dw = dh * (shot.w / shot.h); }
    const dx = rightX + (rightW - dw) / 2;
    try {
      doc.addImage(shot.dataUrl, "JPEG", dx, imgTop, dw, dh);
    } catch {
      drawPlaceholder(doc, rightX, imgTop, rightW, Math.min(maxImgH, rightW * 0.6));
    }
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text("Screenshot uploaded with trade", rightX + rightW / 2, imgTop + Math.min(dh, maxImgH) + 5, { align: "center" });
  } else {
    drawPlaceholder(doc, rightX, imgTop, rightW, Math.min(maxImgH, rightW * 0.6));
  }

  drawFooter(doc);
}

function drawPlaceholder(doc, x, y, w, h) {
  doc.setFillColor(238, 238, 238);
  doc.setDrawColor(210);
  doc.setLineWidth(0.3);
  doc.roundedRect(x, y, w, h, 2, 2, "FD");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text("No screenshot available", x + w / 2, y + h / 2, { align: "center" });
}

// ---------- orchestration ----------
async function runExport(trades, { acc, from, to, lowQuality }) {
  await loadScript(JSPDF_CDN);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  const progress = openProgress(trades.length);
  await paint();

  try {
    drawCover(doc, { acc, from, to, trades });

    let done = 0;
    for (let i = 0; i < trades.length; i += BATCH_SIZE) {
      const batch = trades.slice(i, i + BATCH_SIZE);
      // Fetch this batch's screenshots (bounded concurrency = batch size).
      const shots = await Promise.all(batch.map((t) => fetchScreenshot(t.screenshot_path, lowQuality)));
      for (let j = 0; j < batch.length; j++) {
        const t = batch[j];
        t.__shot = shots[j];
        doc.addPage();
        drawTradePage(doc, t, i + j + 1);
        delete t.__shot; // release the embedded image reference
        shots[j] = null;
        done++;
        progress.set(done);
        await paint();
      }
    }

    const name = `GoldJournal_${sanitize(acc?.name)}_${from || "all"}_${to || "all"}.pdf`;
    doc.save(name);
    progress.close();
    toast("Full report PDF exported.", "success");
  } catch (e) {
    progress.close();
    throw e;
  }
}
