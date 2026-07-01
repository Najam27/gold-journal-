import { state, saveSkipped, deleteSkipped } from "../store.js";
import { toast, confirmDialog, fmtMoney, fmtDate, todayISO, escapeHtml, optionsHtml, skeletonRows } from "../ui.js";
import { openModal } from "../modal.js";
import { exportCSV, exportExcel, skippedToRows } from "../export.js";

const filters = { outcome: "", reason: "" };
let loading = false;
export function setLoading(v) { loading = v; }

export function render(container) {
  const rows = filtered();
  const totalMissed = state.skipped.reduce((s, r) => s + Number(r.est_missed || 0), 0);
  const tpHit = state.skipped.filter((r) => (r.outcome || "").startsWith("TP Hit")).length;
  const goodSkips = state.skipped.filter((r) => (r.outcome || "").includes("SL")).length;

  container.innerHTML = `
  <div class="page-head">
    <div><h1 class="page-title">Missed / Skipped Trades</h1><p class="page-sub">Track what you passed on and why</p></div>
    <div class="page-actions">
      <button class="btn btn-ghost" id="btn-csv"><i data-lucide="file-down"></i> CSV</button>
      <button class="btn btn-ghost" id="btn-xls"><i data-lucide="sheet"></i> Excel</button>
      <button class="btn btn-gold" id="btn-new"><i data-lucide="plus"></i> Log Skipped Trade</button>
    </div>
  </div>

  <div class="stat-strip">
    ${stat("Skipped", state.skipped.length, "eye-off")}
    ${stat("Est. $ Missed", fmtMoney(totalMissed), "trending-down", true)}
    ${stat("Would've Won", tpHit, "check")}
    ${stat("Good Skips (SL)", goodSkips, "shield-check")}
  </div>

  <div class="toolbar glass">
    <div class="toolbar-left">
      <select id="f-outcome" class="mini-select">${optionsHtml(state.options.skipOutcomes, filters.outcome, { placeholder: "All Outcomes" })}</select>
      <select id="f-reason" class="mini-select">${optionsHtml(state.options.skipReasons, filters.reason, { placeholder: "All Reasons" })}</select>
    </div>
    <div class="toolbar-right">
      <button class="btn btn-ghost btn-sm" id="btn-clear"><i data-lucide="filter-x"></i> Clear</button>
    </div>
  </div>

  <div class="table-wrap glass">
    <table class="data-table">
      <thead><tr>
        <th>Date</th><th>Session</th><th>Level</th><th>TF</th><th>Direction</th>
        <th>Skip Reason</th><th>Conf.</th><th>Outcome</th><th>Est. $ Missed</th><th>Notes</th><th>Actions</th>
      </tr></thead>
      <tbody id="skip-body">${loading ? skeletonRows(11) : rowsHtml(rows)}</tbody>
    </table>
    ${!loading && rows.length === 0 ? `<div class="empty-state"><i data-lucide="eye-off"></i><p>No skipped trades logged.</p></div>` : ""}
  </div>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  wire(container);
}

function stat(label, value, icon, money) {
  return `<div class="stat-card glass"><div class="stat-glow"></div><div class="stat-icon"><i data-lucide="${icon}"></i></div>
    <div class="stat-meta"><div class="stat-label">${label}</div><div class="stat-value ${money ? "money" : ""}">${value}</div></div></div>`;
}

function filtered() {
  return state.skipped.filter((r) => {
    if (filters.outcome && r.outcome !== filters.outcome) return false;
    if (filters.reason && r.skip_reason !== filters.reason) return false;
    return true;
  });
}

function rowsHtml(rows) {
  return rows.map((r) => `<tr>
    <td>${fmtDate(r.trade_date)}</td><td>${escapeHtml(r.session || "")}</td><td>${escapeHtml(r.level || "")}</td>
    <td>${escapeHtml(r.timeframe || "")}</td><td>${escapeHtml(r.direction || "")}</td>
    <td>${escapeHtml(r.skip_reason || "")}</td><td>${r.confidence ?? ""}</td>
    <td>${escapeHtml(r.outcome || "")}</td><td><span class="mono">${fmtMoney(r.est_missed)}</span></td>
    <td><span class="notes-cell" title="${escapeHtml(r.notes || "")}">${escapeHtml(r.notes || "")}</span></td>
    <td><div class="row-actions">
      <button class="ic-btn" data-edit="${r.id}"><i data-lucide="pencil"></i></button>
      <button class="ic-btn danger" data-del="${r.id}"><i data-lucide="trash-2"></i></button>
    </div></td></tr>`).join("");
}

function wire(container) {
  const rerender = () => render(container);
  container.querySelector("#btn-csv").addEventListener("click", () => exportCSV(skippedToRows(), "skipped-trades.csv"));
  container.querySelector("#btn-xls").addEventListener("click", () => exportExcel(skippedToRows(), "skipped-trades.xlsx", "Skipped"));
  container.querySelector("#btn-new").addEventListener("click", () => openModalForm(null, rerender));
  container.querySelector("#f-outcome").addEventListener("change", (e) => { filters.outcome = e.target.value; rerender(); });
  container.querySelector("#f-reason").addEventListener("change", (e) => { filters.reason = e.target.value; rerender(); });
  container.querySelector("#btn-clear").addEventListener("click", () => { filters.outcome = filters.reason = ""; rerender(); });
  container.querySelector("#skip-body").addEventListener("click", async (e) => {
    const edit = e.target.closest("[data-edit]");
    const del = e.target.closest("[data-del]");
    if (edit) openModalForm(state.skipped.find((x) => x.id === edit.dataset.edit), rerender);
    if (del) {
      const ok = await confirmDialog({ title: "Delete entry?", body: "This can't be undone.", confirmText: "Delete" });
      if (!ok) return;
      try { await deleteSkipped(del.dataset.del); toast("Deleted.", "success"); } catch (err) { toast(err.message, "error"); }
    }
  });
}

function field(label, inner) { return `<label class="field"><span>${label}</span>${inner}</label>`; }
function sel(name, list, val, ph) { return `<select name="${name}">${optionsHtml(list, val, { placeholder: ph || "—" })}</select>`; }

function openModalForm(row, onDone) {
  const r = row || {};
  const isEdit = !!(row && row.id);
  const o = state.options;
  const bodyHtml = `
  <form id="skip-form" class="modal-form">
    <div class="form-section"><h6>What did I see</h6><div class="grid-2">
      ${field("Date", `<input type="date" name="trade_date" value="${r.trade_date || todayISO()}" required>`)}
      ${field("Session", sel("session", o.sessions, r.session))}
      ${field("Level", sel("level", o.levels, r.level))}
      ${field("Timeframe", sel("timeframe", o.timeframes, r.timeframe))}
      ${field("Direction", sel("direction", o.sides, r.direction))}
    </div></div>
    <div class="form-section"><h6>Why did I skip it</h6><div class="grid-2">
      ${field("Skip Reason", sel("skip_reason", o.skipReasons, r.skip_reason))}
      ${field("Confidence (1-5)", `<input type="number" name="confidence" min="1" max="5" value="${r.confidence ?? ""}">`)}
    </div>
    ${field("Notes", `<textarea name="notes" rows="2">${escapeHtml(r.notes || "")}</textarea>`)}
    </div>
    <div class="form-section"><h6>What happened after</h6><div class="grid-2">
      ${field("Outcome", sel("outcome", o.skipOutcomes, r.outcome))}
      ${field("Estimated $ Missed", `<input type="number" step="0.01" name="est_missed" value="${r.est_missed ?? ""}">`)}
    </div></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
      <button type="submit" class="btn btn-gold" id="save-skip"><span class="btn-label">${isEdit ? "Save" : "Log Skip"}</span></button>
    </div>
  </form>`;
  const m = openModal({ title: isEdit ? "Edit Skipped Trade" : "Log Skipped Trade", bodyHtml, size: "gj-modal-lg" });
  const form = m.body.querySelector("#skip-form");
  form.querySelector("[data-cancel]").addEventListener("click", m.close);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("#save-skip");
    if (btn.disabled) return;
    const fd = new FormData(form);
    const conf = fd.get("confidence");
    if (conf && (conf < 1 || conf > 5)) return toast("Confidence must be 1-5.", "error");
    btn.disabled = true; btn.classList.add("loading");
    try {
      await saveSkipped({
        trade_date: fd.get("trade_date"), session: fd.get("session") || null, level: fd.get("level") || null,
        timeframe: fd.get("timeframe") || null, direction: fd.get("direction") || null,
        skip_reason: fd.get("skip_reason") || null, confidence: conf ? Number(conf) : null,
        outcome: fd.get("outcome") || null, est_missed: Number(fd.get("est_missed") || 0), notes: fd.get("notes") || null,
      }, isEdit ? row.id : null);
      toast(isEdit ? "Updated." : "Skipped trade logged.", "success");
      m.close(); onDone?.();
    } catch (err) { toast(err.message, "error"); }
    finally { btn.disabled = false; btn.classList.remove("loading"); }
  });
}
