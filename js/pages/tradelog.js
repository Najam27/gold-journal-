import { state, ledger, tradeRunningBalance, currentAccount, saveTrade, deleteTrade, clearAllTrades, saveCash, uploadScreenshot, signedUrl } from "../store.js";
import { breachBannersHtml, goalsStatusStripHtml, wireGoalsTradeLog, processGoalNotifications } from "../goalsAlerts.js";
import { toast, confirmDialog, fmtMoney, fmtNum, fmtDate, fmtRR, todayISO, escapeHtml, countUp, optionsHtml, skeletonRows } from "../ui.js";
import { openModal } from "../modal.js";
import { exportTradesPDF } from "../export.js";
import { openFullReport } from "../fullReport.js";

const ALL_COLUMNS = [
  ["idx", "#"], ["date", "Date"], ["session", "Session"], ["side", "Side"], ["level", "Level"],
  ["timeframe", "TF"], ["setup", "Setup"], ["mistake", "Mistake"], ["hold", "Hold"],
  ["market", "Market"], ["bias", "Bias"], ["confirm", "Confirm"], ["sl", "SL"], ["tp", "TP"],
  ["patience", "Patience"], ["risk", "Risk $"], ["reward", "Reward $"], ["rr", "R:R"],
  ["result", "Result"], ["pnl", "P&L"], ["balance", "Balance"], ["notes", "Notes"], ["actions", "Actions"],
];
const DEFAULT_HIDDEN = new Set(["mistake", "hold", "market", "bias", "confirm", "sl", "tp"]);

const filters = { search: "", result: "", session: "", setup: "" };
let hiddenCols = new Set(JSON.parse(localStorage.getItem("gj-hidden-cols") || "null") || [...DEFAULT_HIDDEN]);
let loading = false;

export function setLoading(v) { loading = v; }

export function render(container) {
  processGoalNotifications();
  const acc = currentAccount();
  const l = ledger();
  const trades = filtered();
  const wins = state.trades.filter((t) => t.result === "Win").length;
  const losses = state.trades.filter((t) => t.result === "Loss").length;
  const decided = wins + losses;
  const winRate = decided ? (wins / decided) * 100 : 0;
  const totalPnl = state.trades.reduce((s, t) => s + Number(t.pnl || 0), 0);

  container.innerHTML = `
  <div class="page-head">
    <div>
      <h1 class="page-title">Trade Log</h1>
      <p class="page-sub">${escapeHtml(acc?.name || "")}</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-ghost" id="btn-deposit"><i data-lucide="arrow-down-circle"></i> Deposit</button>
      <button class="btn btn-ghost" id="btn-withdraw"><i data-lucide="arrow-up-circle"></i> Withdraw</button>
      <button class="btn btn-ghost" id="btn-dup"><i data-lucide="copy"></i> Duplicate Last</button>
      <button class="btn btn-ghost" id="btn-full-report"><i data-lucide="file-down"></i> Download Full Report PDF</button>
      <button class="btn btn-gold" id="btn-new"><i data-lucide="plus"></i> New Trade</button>
    </div>
  </div>

  <div class="goal-breach-stack" id="goal-breach-stack">${breachBannersHtml()}</div>

  <div class="stat-strip">
    ${statCard("Balance", "balance", fmtMoney(l.balance), "wallet", true)}
    ${statCard("Win Rate", "winrate", "", "target", false, winRate)}
    ${statCard("Total P&L", "pnl", "", "trending-up", true, totalPnl)}
    ${statCard("Trades", "count", "", "list", false, state.trades.length, true)}
  </div>

  ${goalsStatusStripHtml()}

  <div class="toolbar glass">
    <div class="toolbar-left">
      <div class="search-box"><i data-lucide="search"></i><input id="f-search" placeholder="Search trades…" value="${escapeHtml(filters.search)}"></div>
      <select id="f-result" class="mini-select"><option value="">All Results</option>${optionsHtml([...state.options.results, "Deposit", "Withdraw"], filters.result)}</select>
      <select id="f-session" class="mini-select">${optionsHtml(state.options.sessions, filters.session, { placeholder: "All Sessions" })}</select>
      <select id="f-setup" class="mini-select">${optionsHtml(state.options.setupQuality, filters.setup, { placeholder: "All Setups" })}</select>
    </div>
    <div class="toolbar-right">
      <div class="dropdown" id="cols-dd">
        <button class="btn btn-ghost btn-sm" id="btn-cols"><i data-lucide="columns"></i> Columns</button>
        <div class="dropdown-menu" id="cols-menu"></div>
      </div>
      <button class="btn btn-ghost btn-sm" id="btn-clear-filters"><i data-lucide="filter-x"></i> Clear</button>
      <button class="btn btn-danger btn-sm" id="btn-clear-all"><i data-lucide="trash-2"></i> Clear All</button>
    </div>
  </div>

  <div class="pdf-row glass">
    <span class="pdf-label"><i data-lucide="file-text"></i> PDF report</span>
    <div class="preset-group" id="preset-group">
      <button class="chip active" data-preset="all">All</button>
      <button class="chip" data-preset="week">This week</button>
      <button class="chip" data-preset="month">This month</button>
      <button class="chip" data-preset="custom">Custom</button>
    </div>
    <input type="date" id="pdf-from" class="mini-date" disabled>
    <span class="dash">→</span>
    <input type="date" id="pdf-to" class="mini-date" disabled>
    <button class="btn btn-gold btn-sm" id="btn-pdf"><i data-lucide="download"></i> Download PDF</button>
  </div>

  <div class="table-wrap glass">
    <table class="data-table" id="trades-table">
      <thead><tr>${ALL_COLUMNS.filter((c) => !hiddenCols.has(c[0])).map((c) => `<th>${c[1]}</th>`).join("")}</tr></thead>
      <tbody id="trades-body">
        ${loading ? skeletonRows(ALL_COLUMNS.length - hiddenCols.size) : rowsHtml(trades, l)}
      </tbody>
    </table>
    ${!loading && trades.length === 0 ? emptyState() : ""}
  </div>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  countUp(container.querySelector('[data-stat="winrate"]'), winRate, { pct: true });
  countUp(container.querySelector('[data-stat="pnl"]'), totalPnl, { money: true });
  countUp(container.querySelector('[data-stat="count"]'), state.trades.length);

  wire(container);
  wireGoalsTradeLog(container);
}

function statCard(label, key, value, icon, money, num, plain) {
  return `<div class="stat-card glass">
    <div class="stat-glow"></div>
    <div class="stat-icon"><i data-lucide="${icon}"></i></div>
    <div class="stat-meta"><div class="stat-label">${label}</div>
    <div class="stat-value ${money ? "money" : ""}" data-stat="${key}">${value || (plain ? num : "0")}</div></div>
  </div>`;
}

function emptyState() {
  return `<div class="empty-state">
    <i data-lucide="candlestick-chart"></i>
    <p>No trades yet. Click <strong>New Trade</strong> to log your first XAUUSD trade.</p>
  </div>`;
}

function filtered() {
  const q = filters.search.toLowerCase();
  return state.trades
    .filter((t) => {
      if (filters.result && t.result !== filters.result) return false;
      if (filters.session && t.session !== filters.session) return false;
      if (filters.setup && t.setup_quality !== filters.setup) return false;
      if (q) {
        const hay = [t.notes, t.setup_quality, t.level, t.session, t.side, t.result, t.mistake].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .slice()
    .reverse();
}

function rowsHtml(trades, l) {
  const idxOf = new Map(state.trades.map((t, i) => [t.id, i + 1]));
  return trades
    .map((t) => {
      const rr = fmtRR(t.risk_amount, t.reward_amount);
      const cells = {
        idx: idxOf.get(t.id),
        date: fmtDate(t.trade_date),
        session: escapeHtml(t.session || ""),
        side: t.side ? `<span class="pill ${t.side === "Buy" ? "pill-buy" : "pill-sell"}">${t.side}</span>` : "",
        level: escapeHtml(t.level || ""),
        timeframe: escapeHtml(t.timeframe || ""),
        setup: escapeHtml(t.setup_quality || ""),
        mistake: escapeHtml(t.mistake || ""),
        hold: escapeHtml(t.hold_quality || ""),
        market: escapeHtml(t.market_condition || ""),
        bias: escapeHtml(t.bias_alignment || ""),
        confirm: escapeHtml(t.confirmation_type || ""),
        sl: escapeHtml(t.sl_placement || ""),
        tp: escapeHtml(t.tp_placement || ""),
        patience: t.patience_score ?? "",
        risk: `<span class="mono">${fmtNum(t.risk_amount)}</span>`,
        reward: `<span class="mono">${fmtNum(t.reward_amount)}</span>`,
        rr: `<span class="mono">${rr}</span>`,
        result: resultPill(t.result),
        pnl: `<span class="mono ${Number(t.pnl) >= 0 ? "pos" : "neg"}">${fmtMoney(t.pnl)}</span>`,
        balance: `<span class="mono">${fmtMoney(tradeRunningBalance(t.id))}</span>`,
        notes: `<span class="notes-cell" title="${escapeHtml(t.notes || "")}">${escapeHtml(t.notes || "")}</span>`,
        actions: `<div class="row-actions">
          <button class="ic-btn" data-view="${t.id}" title="View"><i data-lucide="eye"></i></button>
          <button class="ic-btn" data-edit="${t.id}" title="Edit"><i data-lucide="pencil"></i></button>
          <button class="ic-btn danger" data-del="${t.id}" title="Delete"><i data-lucide="trash-2"></i></button>
        </div>`,
      };
      return `<tr>${ALL_COLUMNS.filter((c) => !hiddenCols.has(c[0])).map((c) => `<td>${cells[c[0]] ?? ""}</td>`).join("")}</tr>`;
    })
    .join("");
}

function resultPill(r) {
  const map = { Win: "pill-win", Loss: "pill-loss", "Break-even": "pill-be", Open: "pill-open" };
  return r ? `<span class="pill ${map[r] || ""}">${r}</span>` : "";
}

function wire(container) {
  const rerender = () => render(container);

  container.querySelector("#f-search").addEventListener("input", (e) => { filters.search = e.target.value; refreshBody(container); });
  container.querySelector("#f-result").addEventListener("change", (e) => { filters.result = e.target.value; refreshBody(container); });
  container.querySelector("#f-session").addEventListener("change", (e) => { filters.session = e.target.value; refreshBody(container); });
  container.querySelector("#f-setup").addEventListener("change", (e) => { filters.setup = e.target.value; refreshBody(container); });
  container.querySelector("#btn-clear-filters").addEventListener("click", () => { filters.search = filters.result = filters.session = filters.setup = ""; rerender(); });

  container.querySelector("#btn-new").addEventListener("click", () => openTradeModal(null, rerender));
  container.querySelector("#btn-dup").addEventListener("click", () => {
    if (!state.trades.length) return toast("No trade to duplicate.", "warning");
    const last = { ...state.trades[state.trades.length - 1] };
    delete last.id; delete last.created_at; delete last.updated_at;
    last.trade_date = todayISO();
    openTradeModal(last, rerender, { duplicate: true });
  });
  container.querySelector("#btn-deposit").addEventListener("click", () => openCashModal("deposit", rerender));
  container.querySelector("#btn-withdraw").addEventListener("click", () => openCashModal("withdraw", rerender));
  container.querySelector("#btn-full-report").addEventListener("click", () => openFullReport());

  container.querySelector("#btn-clear-all").addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Clear all trades?", body: "This permanently deletes every trade in this account. Cash transactions are kept.", confirmText: "Delete all" });
    if (!ok) return;
    try { await clearAllTrades(); toast("All trades cleared.", "success"); }
    catch (e) { toast(e.message, "error"); }
  });

  // columns dropdown
  const menu = container.querySelector("#cols-menu");
  menu.innerHTML = ALL_COLUMNS.filter((c) => c[0] !== "idx" && c[0] !== "actions")
    .map((c) => `<label class="dd-check"><input type="checkbox" data-col="${c[0]}" ${hiddenCols.has(c[0]) ? "" : "checked"}> ${c[1]}</label>`).join("");
  container.querySelector("#btn-cols").addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("show"); });
  document.addEventListener("click", () => menu.classList.remove("show"), { once: true });
  menu.addEventListener("click", (e) => e.stopPropagation());
  menu.querySelectorAll("input[data-col]").forEach((cb) => cb.addEventListener("change", () => {
    if (cb.checked) hiddenCols.delete(cb.dataset.col); else hiddenCols.add(cb.dataset.col);
    localStorage.setItem("gj-hidden-cols", JSON.stringify([...hiddenCols]));
    rerender();
  }));

  // PDF row
  const from = container.querySelector("#pdf-from");
  const to = container.querySelector("#pdf-to");
  container.querySelectorAll("#preset-group .chip").forEach((chip) => chip.addEventListener("click", () => {
    container.querySelectorAll("#preset-group .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    const p = chip.dataset.preset;
    const custom = p === "custom";
    from.disabled = to.disabled = !custom;
    const now = new Date();
    if (p === "week") { const d = new Date(now); d.setDate(now.getDate() - now.getDay()); from.value = d.toISOString().slice(0, 10); to.value = todayISO(); }
    else if (p === "month") { from.value = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10); to.value = todayISO(); }
    else if (p === "all") { from.value = ""; to.value = ""; }
  }));
  container.querySelector("#btn-pdf").addEventListener("click", () => exportTradesPDF({ from: from.value || null, to: to.value || null }));

  // row actions (delegated)
  container.querySelector("#trades-body").addEventListener("click", async (e) => {
    const view = e.target.closest("[data-view]");
    const edit = e.target.closest("[data-edit]");
    const del = e.target.closest("[data-del]");
    if (view) openViewModal(view.dataset.view);
    if (edit) { const t = state.trades.find((x) => x.id === edit.dataset.edit); openTradeModal(t, rerender); }
    if (del) {
      const ok = await confirmDialog({ title: "Delete trade?", body: "This can't be undone.", confirmText: "Delete" });
      if (!ok) return;
      try { await deleteTrade(del.dataset.del); toast("Trade deleted.", "success"); }
      catch (err) { toast(err.message, "error"); }
    }
  });
}

function refreshBody(container) {
  const body = container.querySelector("#trades-body");
  if (body) body.innerHTML = rowsHtml(filtered(), ledger());
  window.lucide?.createIcons({ nameAttr: "data-lucide" });
}

// ---------------- Trade modal ----------------
function field(label, inner) {
  return `<label class="field"><span>${label}</span>${inner}</label>`;
}
function sel(name, list, val, ph) {
  return `<select name="${name}">${optionsHtml(list, val, { placeholder: ph || "—" })}</select>`;
}

export function openTradeModal(trade, onDone, { duplicate = false } = {}) {
  const t = trade || {};
  const isEdit = !!(trade && trade.id);
  const o = state.options;
  const sessionValue = !isEdit && !duplicate && !t.session ? detectCurrentSession(o.sessions) : t.session;
  const bodyHtml = `
  <form id="trade-form" class="modal-form">
    <div class="form-section"><h6>Trade Details</h6><div class="grid-2">
      ${field("Date", `<input type="date" name="trade_date" value="${t.trade_date || todayISO()}" required>`)}
      ${field("Session", sel("session", o.sessions, sessionValue))}
      ${field("Direction", sel("side", o.sides, t.side))}
      ${field("Result", sel("result", o.results, t.result))}
    </div></div>
    <div class="form-section"><h6>Strategy</h6><div class="grid-2">
      ${field("Level", sel("level", o.levels, t.level))}
      ${field("Timeframe", sel("timeframe", o.timeframes, t.timeframe))}
      ${field("Setup Quality", sel("setup_quality", o.setupQuality, t.setup_quality))}
      ${field("Confirmation Type", sel("confirmation_type", o.confirmationType, t.confirmation_type))}
    </div></div>
    <div class="form-section"><h6>Execution</h6><div class="grid-2">
      ${field("Market Condition", sel("market_condition", o.marketCondition, t.market_condition))}
      ${field("Direction vs Bias", sel("bias_alignment", o.biasAlignment, t.bias_alignment))}
      ${field("SL Placement", sel("sl_placement", o.slPlacement, t.sl_placement))}
      ${field("TP Placement", sel("tp_placement", o.tpPlacement, t.tp_placement))}
      ${field("Patience Score (1-5)", `<input type="number" name="patience_score" min="1" max="5" value="${t.patience_score ?? ""}">`)}
      ${field("Mistake", sel("mistake", o.mistakeTypes, t.mistake))}
      ${field("Hold Quality", sel("hold_quality", o.holdQuality, t.hold_quality))}
    </div></div>
    <div class="form-section"><h6>Risk</h6><div class="grid-2">
      ${field("Risk $", `<input type="number" step="0.01" name="risk_amount" value="${t.risk_amount ?? ""}">`)}
      ${field("Reward $", `<input type="number" step="0.01" name="reward_amount" value="${t.reward_amount ?? ""}">`)}
      ${field("P&L $", `<input type="number" step="0.01" name="pnl" value="${t.pnl ?? ""}" placeholder="Realised profit/loss">`)}
    </div></div>
    <div class="form-section"><h6>Screenshot</h6>
      <div class="dropzone" id="dropzone">
        <input type="file" id="file-input" accept="image/*" hidden>
        <div class="dz-inner"><i data-lucide="image-plus"></i><span>Drag &amp; drop or click to upload chart</span></div>
        <div class="dz-preview hidden"><img id="dz-img" alt="preview"></div>
        <div class="progress hidden" id="dz-progress"><span></span></div>
      </div>
    </div>
    <div class="form-section"><h6>Notes</h6>
      ${field("", `<textarea name="notes" rows="3" placeholder="What happened, how you felt, lessons…">${escapeHtml(t.notes || "")}</textarea>`)}
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
      <button type="submit" class="btn btn-gold" id="save-trade"><span class="btn-label">${isEdit ? "Save Changes" : "Save Trade"}</span></button>
    </div>
  </form>`;

  const m = openModal({ title: isEdit ? "Edit Trade" : duplicate ? "Duplicate Trade" : "New Trade", bodyHtml, size: "gj-modal-lg" });
  const form = m.body.querySelector("#trade-form");
  form.querySelector("[data-cancel]").addEventListener("click", m.close);

  // screenshot handling
  let pendingFile = null;
  let existingPath = t.screenshot_path || null;
  const dz = form.querySelector("#dropzone");
  const fileInput = form.querySelector("#file-input");
  const preview = form.querySelector(".dz-preview");
  const img = form.querySelector("#dz-img");
  const showPreview = (src) => { img.src = src; preview.classList.remove("hidden"); dz.querySelector(".dz-inner").classList.add("hidden"); };
  if (existingPath) signedUrl(existingPath).then((u) => u && showPreview(u));
  dz.addEventListener("click", () => fileInput.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("drag"); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener("change", (e) => e.target.files[0] && handleFile(e.target.files[0]));
  function handleFile(f) {
    if (!f.type.startsWith("image/")) return toast("Please choose an image file.", "error");
    if (f.size > 8 * 1024 * 1024) return toast("Image too large (max 8MB).", "error");
    pendingFile = f;
    showPreview(URL.createObjectURL(f));
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("#save-trade");
    if (btn.disabled) return;
    const fd = new FormData(form);
    const patience = fd.get("patience_score");
    if (patience && (patience < 1 || patience > 5)) return toast("Patience score must be 1-5.", "error");
    btn.disabled = true; btn.classList.add("loading");
    try {
      let screenshot_path = existingPath;
      if (pendingFile && !navigator.onLine) {
        toast("Offline: trade will sync on reconnect. Add the screenshot again once online.", "warning");
      } else if (pendingFile) {
        const prog = form.querySelector("#dz-progress");
        prog.classList.remove("hidden");
        screenshot_path = await uploadScreenshot(pendingFile, (p) => { prog.querySelector("span").style.width = p + "%"; });
      }
      const payload = {
        trade_date: fd.get("trade_date"),
        session: fd.get("session") || null,
        side: fd.get("side") || null,
        level: fd.get("level") || null,
        timeframe: fd.get("timeframe") || null,
        setup_quality: fd.get("setup_quality") || null,
        confirmation_type: fd.get("confirmation_type") || null,
        market_condition: fd.get("market_condition") || null,
        bias_alignment: fd.get("bias_alignment") || null,
        sl_placement: fd.get("sl_placement") || null,
        tp_placement: fd.get("tp_placement") || null,
        patience_score: patience ? Number(patience) : null,
        mistake: fd.get("mistake") || null,
        hold_quality: fd.get("hold_quality") || null,
        risk_amount: Number(fd.get("risk_amount") || 0),
        reward_amount: Number(fd.get("reward_amount") || 0),
        pnl: Number(fd.get("pnl") || 0),
        result: fd.get("result") || null,
        notes: fd.get("notes") || null,
        screenshot_path,
      };
      await saveTrade(payload, isEdit ? trade.id : null);
      toast(isEdit ? "Trade updated." : "Trade saved.", "success");
      m.close();
      onDone?.();
    } catch (err) {
      toast(err.message || "Save failed.", "error");
    } finally {
      btn.disabled = false; btn.classList.remove("loading");
    }
  });
}

function detectCurrentSession(sessions = []) {
  const now = new Date();
  const pktHour = (now.getUTCHours() + 5) % 24;
  const ranges = [
    ["Pre-Asian", 3, 4],
    ["Asian", 5, 7],
    ["Post-Asian", 8, 9],
    ["Pre-London", 10, 11],
    ["London", 12, 13],
    ["Post-London", 14, 15],
    ["Pre-NY", 16, 16],
    ["New York", 17, 19],
    ["Post-NY", 20, 23],
    ["Post-NY", 0, 2],
  ];
  const label = ranges.find(([, start, end]) => pktHour >= start && pktHour <= end)?.[0];
  return sessions.find((s) => String(s).toLowerCase().startsWith(label?.toLowerCase() || "")) || "";
}

// ---------------- View modal ----------------
async function openViewModal(id) {
  const t = state.trades.find((x) => x.id === id);
  if (!t) return;
  const rr = fmtRR(t.risk_amount, t.reward_amount);
  const rows = [
    ["Date", fmtDate(t.trade_date)], ["Session", t.session], ["Side", t.side], ["Level", t.level],
    ["Timeframe", t.timeframe], ["Setup", t.setup_quality], ["Confirmation", t.confirmation_type],
    ["Market", t.market_condition], ["Bias", t.bias_alignment], ["SL", t.sl_placement], ["TP", t.tp_placement],
    ["Patience", t.patience_score], ["Mistake", t.mistake], ["Hold", t.hold_quality],
    ["Risk $", fmtNum(t.risk_amount)], ["Reward $", fmtNum(t.reward_amount)], ["R:R", rr],
    ["Result", t.result], ["P&L", fmtMoney(t.pnl)], ["Balance", fmtMoney(tradeRunningBalance(t.id))],
  ];
  const bodyHtml = `
  <div class="view-grid">
    ${rows.map(([k, v]) => `<div class="view-item"><span class="vk">${k}</span><span class="vv">${escapeHtml(v ?? "—")}</span></div>`).join("")}
  </div>
  ${t.notes ? `<div class="view-notes"><span class="vk">Notes</span><p>${escapeHtml(t.notes)}</p></div>` : ""}
  <div id="view-shot" class="view-shot"></div>`;
  const m = openModal({ title: "Trade Details", bodyHtml, size: "gj-modal-lg" });
  if (t.screenshot_path) {
    const url = await signedUrl(t.screenshot_path);
    if (url) m.body.querySelector("#view-shot").innerHTML = `<img src="${url}" alt="chart screenshot">`;
  }
}

// ---------------- Cash modal ----------------
function openCashModal(type, onDone) {
  const bodyHtml = `
  <form id="cash-form" class="modal-form">
    <div class="grid-2">
      ${field("Date", `<input type="date" name="tx_date" value="${todayISO()}" required>`)}
      ${field("Amount $", `<input type="number" step="0.01" min="0" name="amount" required placeholder="0.00">`)}
    </div>
    ${field("Note", `<input type="text" name="note" placeholder="Optional note">`)}
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
      <button type="submit" class="btn ${type === "withdraw" ? "btn-danger" : "btn-gold"}" id="save-cash"><span class="btn-label">${type === "withdraw" ? "Withdraw" : "Deposit"}</span></button>
    </div>
  </form>`;
  const m = openModal({ title: type === "withdraw" ? "Withdraw Funds" : "Deposit Funds", bodyHtml });
  const form = m.body.querySelector("#cash-form");
  form.querySelector("[data-cancel]").addEventListener("click", m.close);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("#save-cash");
    if (btn.disabled) return;
    const fd = new FormData(form);
    const amt = Number(fd.get("amount"));
    if (!amt || amt <= 0) return toast("Enter a positive amount.", "error");
    btn.disabled = true; btn.classList.add("loading");
    try {
      await saveCash({ tx_date: fd.get("tx_date"), type, amount: amt, note: fd.get("note") || null });
      toast(`${type === "withdraw" ? "Withdrawal" : "Deposit"} recorded.`, "success");
      m.close(); onDone?.();
    } catch (err) { toast(err.message, "error"); }
    finally { btn.disabled = false; btn.classList.remove("loading"); }
  });
}
