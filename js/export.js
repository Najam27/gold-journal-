// Export helpers: CSV, Excel (SheetJS), PDF (jsPDF + autotable).
// Libraries are loaded on demand from CDN to keep initial load light.
import { toast, fmtMoney, fmtDate } from "./ui.js";
import { state, ledger, tradeRunningBalance } from "./store.js";

async function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

const CDN = {
  xlsx: "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
  jspdf: "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
  autotable: "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js",
};

export function tradesToRows() {
  return state.trades.map((t, i) => ({
    "#": i + 1,
    Date: t.trade_date,
    Session: t.session || "",
    Side: t.side || "",
    Level: t.level || "",
    Timeframe: t.timeframe || "",
    Setup: t.setup_quality || "",
    Mistake: t.mistake || "",
    "Hold Quality": t.hold_quality || "",
    "Market Condition": t.market_condition || "",
    "Bias Alignment": t.bias_alignment || "",
    "Confirmation Type": t.confirmation_type || "",
    "SL Placement": t.sl_placement || "",
    "TP Placement": t.tp_placement || "",
    "Patience Score": t.patience_score ?? "",
    "Risk $": Number(t.risk_amount || 0),
    "Reward $": Number(t.reward_amount || 0),
    "R:R": t.risk_amount ? (Number(t.reward_amount) / Number(t.risk_amount)).toFixed(2) : "",
    Result: t.result || "",
    "P&L": Number(t.pnl || 0),
    "Running Balance": Number(tradeRunningBalance(t.id) || 0).toFixed(2),
    Notes: t.notes || "",
  }));
}

export function skippedToRows() {
  return state.skipped.map((s) => ({
    Date: s.trade_date,
    Session: s.session || "",
    Level: s.level || "",
    Timeframe: s.timeframe || "",
    Direction: s.direction || "",
    "Skip Reason": s.skip_reason || "",
    Confidence: s.confidence ?? "",
    Outcome: s.outcome || "",
    "Estimated $ Missed": Number(s.est_missed || 0),
    Notes: s.notes || "",
  }));
}

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportCSV(rows, filename) {
  try {
    if (!rows.length) return toast("Nothing to export.", "warning");
    const headers = Object.keys(rows[0]);
    const escape = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))].join("\n");
    download(filename, new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    toast("CSV exported.", "success");
  } catch (e) {
    toast("CSV export failed.", "error");
  }
}

export async function exportExcel(rows, filename, sheet = "Sheet1") {
  try {
    if (!rows.length) return toast("Nothing to export.", "warning");
    await loadScript(CDN.xlsx);
    const XLSX = window.XLSX;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheet);
    XLSX.writeFile(wb, filename);
    toast("Excel exported.", "success");
  } catch (e) {
    toast("Excel export failed.", "error");
  }
}

export async function exportTradesPDF({ from, to, title = "Gold Journal — Trade Report" } = {}) {
  try {
    await loadScript(CDN.jspdf);
    await loadScript(CDN.autotable);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape" });

    let trades = [...state.trades];
    if (from) trades = trades.filter((t) => t.trade_date >= from);
    if (to) trades = trades.filter((t) => t.trade_date <= to);

    const l = ledger();
    const wins = trades.filter((t) => t.result === "Win").length;
    const losses = trades.filter((t) => t.result === "Loss").length;
    const decided = wins + losses;
    const totalPnl = trades.reduce((s, t) => s + Number(t.pnl || 0), 0);

    doc.setFontSize(18);
    doc.setTextColor(212, 175, 55);
    doc.text(title, 14, 16);
    doc.setFontSize(10);
    doc.setTextColor(80);
    const acct = state.accounts.find((a) => a.id === state.currentAccountId);
    doc.text(
      [
        `Account: ${acct?.name || "-"}    Range: ${from || "All"} → ${to || "All"}`,
        `Balance: ${fmtMoney(l.balance)}    Total P&L: ${fmtMoney(totalPnl)}    Win rate: ${decided ? ((wins / decided) * 100).toFixed(1) : 0}%    Trades: ${trades.length}`,
      ],
      14,
      24
    );

    const head = [["#", "Date", "Session", "Side", "Setup", "Result", "Risk $", "Reward $", "P&L", "Balance"]];
    const body = trades.map((t, i) => [
      i + 1,
      fmtDate(t.trade_date),
      t.session || "",
      t.side || "",
      t.setup_quality || "",
      t.result || "",
      Number(t.risk_amount || 0).toFixed(2),
      Number(t.reward_amount || 0).toFixed(2),
      Number(t.pnl || 0).toFixed(2),
      Number(tradeRunningBalance(t.id) || 0).toFixed(2),
    ]);

    doc.autoTable({
      head,
      body,
      startY: 34,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [26, 32, 44], textColor: [212, 175, 55] },
      alternateRowStyles: { fillColor: [245, 245, 245] },
    });

    doc.save(filename(from, to));
    toast("PDF exported.", "success");
  } catch (e) {
    console.error(e);
    toast("PDF export failed.", "error");
  }
}

function filename(from, to) {
  const stamp = new Date().toISOString().slice(0, 10);
  return `gold-journal-${from || "all"}_${to || stamp}.pdf`;
}
