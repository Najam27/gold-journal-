import {
  state, currentAccount, switchAccount, saveGoal, deleteGoal, toggleGoalActive,
} from "../store.js";
import {
  evaluationsForPage, notificationPermission, requestNotificationPermission,
  shouldFlashCard, clearFlash, processGoalNotifications,
} from "../goalsAlerts.js";
import {
  listPastMonths, monthHistory, customTrackToType, comparisonFromDirection,
} from "../goalsEngine.js";
import { toast, confirmDialog, escapeHtml, fmtNum } from "../ui.js";
import { openModal } from "../modal.js";

let periodFilter = "daily";
let recalcTimer = null;
let expandedMonths = new Set();

const PERIOD_LABELS = { daily: "Daily Goals", weekly: "Weekly Goals", monthly: "Monthly Goals" };
const PERIOD_HINTS = {
  daily: "Resets every midnight",
  weekly: "Resets every Monday 00:00",
  monthly: "Resets every 1st of month",
};

export function render(container) {
  processGoalNotifications();
  const acc = currentAccount();
  const evaluated = evaluationsForPage("all");
  const periods = ["daily", "weekly", "monthly"];

  container.innerHTML = `
  <div class="page-head">
    <div>
      <h1 class="page-title">Goals</h1>
      <p class="page-sub">Trading discipline targets for ${escapeHtml(acc?.name || "")}</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-ghost btn-sm" id="btn-notify" title="Desktop notifications">
        <i data-lucide="bell"></i> ${notifyBtnLabel()}
      </button>
      <button class="btn btn-gold" id="btn-add-goal"><i data-lucide="plus"></i> Add Custom Goal</button>
    </div>
  </div>

  <div class="goals-toolbar glass">
    <div class="goals-acct">
      <label>Account</label>
      <select id="goals-acct-select" class="mini-select">
        ${state.accounts.map((a) => `<option value="${a.id}" ${a.id === state.currentAccountId ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("")}
      </select>
    </div>
    <div class="period-toggle">
      ${periods.map((p) => `<button class="chip ${periodFilter === p ? "active" : ""}" data-period="${p}">${p.charAt(0).toUpperCase() + p.slice(1)}</button>`).join("")}
    </div>
  </div>

  <div class="goals-sections" id="goals-sections">
    ${periods.map((p) => sectionHtml(p, evaluated.filter((e) => e.goal.period === p))).join("")}
  </div>

  <div class="goals-history glass card-pad">
    <div class="gh-head">
      <h6><i data-lucide="history"></i> Past Periods</h6>
      <span class="count-badge">${listPastMonths(6).length} months</span>
    </div>
    <div id="past-months">${pastMonthsHtml()}</div>
  </div>

  <p class="goals-notify-note note"><i data-lucide="info"></i> Notifications only work while this browser tab is open.</p>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  wire(container);
  startRecalcTimer(container);
}

function notifyBtnLabel() {
  const p = notificationPermission();
  if (p === "granted") return "Notifications on";
  if (p === "denied") return "Notifications blocked";
  return "Enable desktop notifications";
}

function sectionHtml(period, items) {
  const expanded = periodFilter === period;
  return `
  <div class="goals-section ${expanded ? "active-period" : ""}" data-section="${period}">
    <button class="goals-section-head" data-toggle-section="${period}">
      <span><i data-lucide="chevron-${expanded ? "down" : "right"}"></i> ${PERIOD_LABELS[period]}</span>
      <span class="goals-section-hint">${PERIOD_HINTS[period]}</span>
      <span class="count-badge">${items.filter((e) => e.goal.is_active).length} active</span>
    </button>
    <div class="goals-grid ${expanded ? "" : "collapsed"}" id="grid-${period}">
      ${items.length ? items.map(goalCard).join("") : `<div class="empty-state small"><p>No goals in this period.</p></div>`}
    </div>
  </div>`;
}

function goalCard(ev) {
  const g = ev.goal;
  const flash = shouldFlashCard(g.id) && ev.status === "BREACHED";
  const statusClass = ev.status.toLowerCase().replace("_", "-");
  const barClass = ev.status === "MET" ? "bar-met" : ev.status === "BREACHED" ? "bar-breach" : ev.status === "AT_RISK" ? "bar-risk" : "bar-pending";
  const progress = Math.min(100, Math.max(0, ev.progress || 0));
  return `
  <div class="goal-card glass ${flash ? "goal-flash" : ""} ${!g.is_active ? "goal-inactive" : ""}" data-goal="${g.id}">
    <div class="gc-head">
      <h6 class="gc-title">${escapeHtml(g.title)}</h6>
      <span class="goal-badge goal-badge-${statusClass}">${ev.inactive ? "PAUSED" : ev.status.replace("_", " ")}</span>
    </div>
    <div class="gc-progress">
      <div class="gc-progress-label">${escapeHtml(formatProgressLabel(g.type))}: <b>${ev.displayCurrent}</b> / ${ev.displayTarget} target</div>
      <div class="gc-bar"><span class="gc-bar-fill ${barClass}" style="width:${progress}%"></span></div>
    </div>
    <div class="gc-foot">
      <label class="goal-switch" title="${g.is_active ? "Deactivate" : "Activate"}">
        <input type="checkbox" data-toggle="${g.id}" ${g.is_active ? "checked" : ""}>
        <span class="goal-switch-ui"></span>
      </label>
      <div class="gc-actions">
        <button class="ic-btn" data-edit="${g.id}" title="Edit target"><i data-lucide="pencil"></i></button>
        ${!g.is_default ? `<button class="ic-btn danger" data-del="${g.id}" title="Delete"><i data-lucide="trash-2"></i></button>` : ""}
      </div>
    </div>
  </div>`;
}

function formatProgressLabel(type) {
  const map = {
    max_trades: "Trades", max_loss_day: "Daily Loss", max_loss_week: "Weekly Loss",
    profit_target: "Net P&L", win_rate: "Win Rate", min_rr: "Avg R:R",
    max_consecutive_losses: "Loss Streak", setup_quality: "A/A+ Setups",
    patience_score: "Patience", no_revenge_trade: "Min Gap", screenshot_rate: "Screenshots",
    weekly_review: "Reviews", profit_factor: "Profit Factor", drawdown_pct: "Drawdown",
  };
  return map[type] || "Progress";
}

function pastMonthsHtml() {
  const months = listPastMonths(6);
  if (!months.length) return `<p class="muted small">No past months yet.</p>`;
  return months.map(({ year, month }) => {
    const label = new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const hist = monthHistory(state.goals, year, month);
    const key = `${year}-${month}`;
    const open = expandedMonths.has(key);
    return `
    <div class="past-month-item">
      <button class="past-month-head" data-month="${key}">
        <i data-lucide="chevron-${open ? "down" : "right"}"></i>
        <span>${label}: <b>${hist.met}/${hist.total}</b> goals met</span>
      </button>
      ${open ? `<div class="past-month-body">${hist.results.map((r) => `
        <div class="pm-goal pm-${r.status.toLowerCase()}">
          <span>${escapeHtml(r.goal.title)}</span>
          <span class="goal-badge goal-badge-${r.status.toLowerCase().replace("_", "-")}">${r.status}</span>
        </div>`).join("")}</div>` : ""}
    </div>`;
  }).join("");
}

function wire(container) {
  container.querySelector("#btn-add-goal")?.addEventListener("click", () => openCustomGoalModal(() => render(container)));
  container.querySelector("#btn-notify")?.addEventListener("click", async () => {
    const res = await requestNotificationPermission();
    if (res === "granted") toast("Desktop notifications enabled.", "success");
    else if (res === "denied") toast("Notifications blocked in browser settings.", "warning");
    else if (res === "unsupported") toast("Notifications not supported in this browser.", "warning");
    render(container);
  });

  container.querySelector("#goals-acct-select")?.addEventListener("change", async (e) => {
    try {
      await switchAccount(e.target.value);
      toast("Switched account.", "info");
      render(container);
    } catch (err) { toast(err.message, "error"); }
  });

  container.querySelectorAll("[data-period]").forEach((btn) => {
    btn.addEventListener("click", () => {
      periodFilter = btn.dataset.period;
      render(container);
    });
  });

  container.querySelectorAll("[data-toggle-section]").forEach((btn) => {
    btn.addEventListener("click", () => {
      periodFilter = btn.dataset.toggleSection;
      render(container);
    });
  });

  container.querySelectorAll("[data-toggle]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      try {
        await toggleGoalActive(cb.dataset.toggle, cb.checked);
      } catch (err) { toast(err.message, "error"); cb.checked = !cb.checked; }
    });
  });

  container.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const g = state.goals.find((x) => x.id === btn.dataset.edit);
      if (g) openEditModal(g, () => render(container));
    });
  });

  container.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog({ title: "Delete goal?", body: "This custom goal will be permanently removed.", confirmText: "Delete" });
      if (!ok) return;
      try { await deleteGoal(btn.dataset.del); toast("Goal deleted.", "success"); render(container); }
      catch (err) { toast(err.message, "error"); }
    });
  });

  container.querySelectorAll(".goal-card[data-goal]").forEach((card) => {
    if (card.classList.contains("goal-flash")) {
      setTimeout(() => clearFlash(card.dataset.goal), 3000);
    }
  });

  container.querySelectorAll("[data-month]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.month;
      if (expandedMonths.has(key)) expandedMonths.delete(key);
      else expandedMonths.add(key);
      render(container);
    });
  });
}

function startRecalcTimer(container) {
  if (recalcTimer) clearInterval(recalcTimer);
  recalcTimer = setInterval(() => {
    if (document.getElementById("page")?.contains(container)) render(container);
  }, 5 * 60 * 1000);
}

function openEditModal(goal, onDone) {
  const bodyHtml = `
  <form id="edit-goal-form" class="modal-form">
    <label class="field"><span>Goal name</span><input type="text" name="title" value="${escapeHtml(goal.title)}" required></label>
    <label class="field"><span>Target value</span><input type="number" step="any" name="target_value" value="${goal.target_value}" required></label>
    <label class="field"><span>Notify on breach</span>
      <label class="goal-switch inline"><input type="checkbox" name="notify_on_breach" ${goal.notify_on_breach ? "checked" : ""}><span class="goal-switch-ui"></span></label>
    </label>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
      <button type="submit" class="btn btn-gold">Save</button>
    </div>
  </form>`;
  const m = openModal({ title: "Edit Goal", bodyHtml });
  const form = m.body.querySelector("#edit-goal-form");
  form.querySelector("[data-cancel]").addEventListener("click", m.close);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await saveGoal({
        title: fd.get("title"),
        target_value: Number(fd.get("target_value")),
        notify_on_breach: !!fd.get("notify_on_breach"),
      }, goal.id);
      toast("Goal updated.", "success");
      m.close();
      onDone?.();
    } catch (err) { toast(err.message, "error"); }
  });
}

function openCustomGoalModal(onDone) {
  const bodyHtml = `
  <form id="custom-goal-form" class="modal-form">
    <label class="field"><span>Goal name</span><input type="text" name="title" placeholder="My custom goal" required></label>
    <label class="field"><span>Period</span>
      <select name="period"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
    </label>
    <label class="field"><span>What to track</span>
      <select name="track" id="custom-track">
        <option value="pnl">Net P&L</option>
        <option value="count">Trade Count</option>
        <option value="win_rate">Win Rate</option>
        <option value="rr">R:R</option>
        <option value="loss">Loss Amount</option>
        <option value="patience">Patience Score</option>
        <option value="drawdown">Drawdown %</option>
        <option value="custom">Custom</option>
      </select>
    </label>
    <label class="field"><span>Target value</span><input type="number" step="any" name="target_value" required></label>
    <label class="field"><span>Direction</span>
      <select name="direction">
        <option value="above">Must be above</option>
        <option value="below">Must be below</option>
        <option value="equal">Must equal</option>
      </select>
    </label>
    <label class="field"><span>Notify on breach</span>
      <label class="goal-switch inline"><input type="checkbox" name="notify_on_breach" checked><span class="goal-switch-ui"></span></label>
    </label>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
      <button type="submit" class="btn btn-gold">Save</button>
    </div>
  </form>`;
  const m = openModal({ title: "Add Custom Goal", bodyHtml });
  const form = m.body.querySelector("#custom-goal-form");
  form.querySelector("[data-cancel]").addEventListener("click", m.close);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const period = fd.get("period");
    const track = fd.get("track");
    const type = customTrackToType(track, period);
    try {
      await saveGoal({
        title: fd.get("title"),
        type,
        period,
        target_value: Number(fd.get("target_value")),
        comparison: comparisonFromDirection(fd.get("direction")),
        is_active: true,
        is_default: false,
        notify_on_breach: !!fd.get("notify_on_breach"),
      });
      toast("Goal created.", "success");
      m.close();
      onDone?.();
    } catch (err) { toast(err.message, "error"); }
  });
}
