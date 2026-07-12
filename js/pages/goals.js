import {
  state, currentAccount, switchAccount, saveGoal, deleteGoal, toggleGoalActive,
} from "../store.js";
import {
  evaluationsForPage, notificationPermission, requestNotificationPermission,
  shouldFlashCard, clearFlash, processGoalNotifications,
  getNotificationCenter, clearAllNotifications, markAllNotificationsRead, getBreachLogForExport, updateBreachLog,
} from "../goalsAlerts.js";
import {
  listPastMonths, monthHistory, customTrackToType, comparisonFromDirection,
  getPKTDate, getPKTDateKey,
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
      ${notificationToggleHtml()}
      <button class="btn btn-gold" id="btn-add-goal"><i data-lucide="plus"></i> Add Custom Goal</button>
    </div>
  </div>

  <div class="notification-dropdown glass card-pad" id="notification-dropdown" hidden>
    ${notificationDropdownHtml()}
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

function notifyButtonHtml() {
  const p = notificationPermission();
  const { unreadCount } = getNotificationCenter();
  if (p === "denied") {
    return `<span class="notify-state blocked">blocked</span>`;
  }
  if (p === "granted") {
    return unreadCount > 0 ? `<span class="notify-count">${unreadCount}</span>` : "";
  }
  return "";
}

function notificationToggleHtml() {
  const p = notificationPermission();
  const unreadCount = getNotificationCenter().unreadCount;
  return `
  <button class="btn btn-ghost btn-sm notify-toggle ${p === "denied" ? "blocked" : ""}" id="btn-notify" title="Notifications" aria-expanded="false">
    <span class="notify-icon">
      <i data-lucide="bell"></i>
      ${p === "granted" && unreadCount > 0 ? `<span class="notify-count">${unreadCount}</span>` : ""}
    </span>
    ${p === "denied" ? `<span class="notify-state blocked">blocked</span>` : ""}
  </button>`;
}

function sectionHtml(period, items) {
  return `
  <div class="goals-section glass" data-section="${period}">
    <button class="goals-section-head" type="button">
      <span><i data-lucide="chevron-down"></i> ${PERIOD_LABELS[period]}</span>
      <span class="goals-section-hint">${PERIOD_HINTS[period]}</span>
      <span class="count-badge">${items.filter((e) => e.goal.is_active).length} active</span>
    </button>
    <div class="goals-table-wrapper" id="grid-${period}">
      ${items.length ? `
      <table class="goals-table">
        <thead>
          <tr>
            <th>NAME</th>
            <th>TARGET</th>
            <th>PROGRESS</th>
            <th>STATUS</th>
            <th>ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(goalRow).join("")}
        </tbody>
      </table>
      ` : `<div class="empty-state small"><p>No goals in this period.</p></div>`}
    </div>
  </div>`;
}

function goalRow(ev) {
  const g = ev.goal;
  const flash = shouldFlashCard(g.id) && ev.status === "BREACHED";
  const statusClass = ev.status.toLowerCase().replace("_", "-");
  const barClass = ev.status === "MET" ? "bar-met" : ev.status === "BREACHED" ? "bar-breach" : ev.status === "AT_RISK" ? "bar-risk" : "bar-pending";
  const progress = Math.min(100, Math.max(0, ev.progress || 0));
  
  // Format TARGET display
  let targetDisplay = "";
  if (g.type === "no_revenge_trade") {
    targetDisplay = ev.status === "BREACHED" ? `<span class="target-breached">BREACHED</span>` : `<span class="target-met">CLEAR</span>`;
  } else {
    targetDisplay = `<span class="${ev.status === "BREACHED" ? "target-breached" : ev.status === "MET" ? "target-met" : "target-pending"}">${ev.displayCurrent} / ${ev.displayTarget}</span>`;
  }

  return `
  <tr class="goal-row ${flash ? "goal-flash" : ""} ${!g.is_active ? "goal-inactive" : ""}" data-goal="${g.id}">
    <td class="cell-name">
      <span class="goal-title">${escapeHtml(g.title)}</span>
    </td>
    <td class="cell-target">
      ${targetDisplay}
    </td>
    <td class="cell-progress">
      <div class="goal-progress-bar">
        <span class="goal-bar-fill ${barClass}" style="width:${progress}%"></span>
      </div>
    </td>
    <td class="cell-status">
      <span class="goal-badge goal-badge-${statusClass}">${ev.inactive ? "PAUSED" : ev.status.replace("_", " ")}</span>
    </td>
    <td class="cell-actions">
      <label class="goal-switch" title="${g.is_active ? "Deactivate" : "Activate"}">
        <input type="checkbox" data-toggle="${g.id}" ${g.is_active ? "checked" : ""}>
        <span class="goal-switch-ui"></span>
      </label>
      <button class="ic-btn" data-edit="${g.id}" title="Edit target"><i data-lucide="pencil"></i></button>
      ${!g.is_default ? `<button class="ic-btn danger" data-del="${g.id}" title="Delete"><i data-lucide="trash-2"></i></button>` : ""}
    </td>
  </tr>`;
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
  return `
  <table class="past-months-table">
    <thead>
      <tr>
        <th>MONTH</th>
        <th>TARGET</th>
        <th>SUCCESS</th>
        <th>PROGRESS</th>
      </tr>
    </thead>
    <tbody>
      ${months.map(({ year, month }) => {
        const label = new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
        const hist = monthHistory(state.goals, year, month);
        const key = `${year}-${month}`;
        const open = expandedMonths.has(key);
        const successPercentage = hist.total > 0 ? Math.round((hist.met / hist.total) * 100) : 0;
        const monthLabel = hist.noData
          ? `<span class="pm-month-label-text">${label}</span>`
          : `<button class="pm-expand-btn" data-month="${key}" title="View details">
              <i data-lucide="chevron-${open ? "down" : "right"}"></i>
              ${label}
            </button>`;
        const targetCell = hist.noData ? "—" : `${hist.total} goals`;
        const successCell = hist.noData ? "No trades" : `${hist.met}/${hist.total}`;
        return `
        <tr class="past-month-row">
          <td class="pm-month-label">
            ${monthLabel}
          </td>
          <td class="pm-target">${targetCell}</td>
          <td class="pm-success">${successCell}</td>
          <td class="pm-progress">
            <div class="past-month-bar">
              <span class="past-month-bar-fill" style="width:${hist.noData ? 0 : successPercentage}%"></span>
            </div>
          </td>
        </tr>
        ${!hist.noData && open ? `<tr class="pm-details-row"><td colspan="4"><div class="pm-details">
          ${hist.results.map((r) => `
          <div class="pm-goal pm-${r.status.toLowerCase()}">
            <span>${escapeHtml(r.goal.title)}</span>
            <span class="goal-badge goal-badge-${r.status.toLowerCase().replace("_", "-")}">${r.status}</span>
          </div>`).join("")}
        </div></td></tr>` : ""}
        `;
      }).join("")}
    </tbody>
  </table>`;
}

function notificationDropdownHtml() {
  const { notifications, unreadCount, totalCount } = getNotificationCenter();

  const formatTime = (isoStr) => {
    const date = getPKTDate(new Date(isoStr));
    const now = getPKTDate();
    const todayKey = getPKTDateKey(now);
    const dateKey = date.toISOString().slice(0, 10);
    const timeLabel = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
    if (dateKey === todayKey) return `Today ${timeLabel}`;
    const yesterdayKey = getPKTDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    if (dateKey === yesterdayKey) return `Yesterday ${timeLabel}`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  };

  const renderNotif = (n) => `
  <div class="nc-item nc-item-breached" data-notif-id="${n.id}">
    <span class="nc-icon"><i data-lucide="alert-triangle"></i></span>
    <div class="nc-content">
      <div class="nc-content-head">
        <span class="nc-goal-name">${escapeHtml(n.goal_name)}</span>
        <span class="nc-time">${formatTime(n.breached_at)}</span>
      </div>
      <div class="nc-message">${escapeHtml(n.value_at_breach)} / ${escapeHtml(n.target)}</div>
    </div>
    <button class="nc-dismiss" data-dismiss-notif="${n.id}" title="Dismiss" aria-label="Dismiss">
      <i data-lucide="x"></i>
    </button>
  </div>`;

  if (totalCount === 0 || notifications.length === 0) {
    return `<div class="nc-empty"><p>No active notifications</p></div>`;
  }

  const unreadBadge = unreadCount > 0 ? `<span class="nc-badge">${unreadCount} new</span>` : "";
  const groups = ["daily", "weekly", "monthly"].map((period) => {
    const items = notifications.filter((n) => n.period === period);
    if (!items.length) return "";
    const label = period === "daily" ? "TODAY" : period === "weekly" ? "THIS WEEK" : "THIS MONTH";
    return `
    <div class="nc-group">
      <div class="nc-group-label">${label}</div>
      ${items.map(renderNotif).join("")}
    </div>`;
  }).filter(Boolean).join("");

  return `
  <div class="nc-head">
    <div class="nc-head-left">
      <h6><i data-lucide="bell"></i> Notification History</h6>
      ${unreadBadge}
    </div>
    <div class="nc-head-actions">
      <button class="nc-btn nc-btn-sm" id="btn-mark-read" title="Mark all as read">Mark All Read</button>
      <button class="nc-btn nc-btn-sm" id="btn-clear-notif" title="Clear all">Clear All</button>
    </div>
  </div>
  <div class="nc-list">
    ${groups}
  </div>`;
}

let notificationDocClickWired = false;

function wire(container) {
  container.querySelector("#btn-add-goal")?.addEventListener("click", () => openCustomGoalModal(() => render(container)));
  const notifyBtn = container.querySelector("#btn-notify");
  const dropdown = container.querySelector("#notification-dropdown");

  notifyBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    const expanded = dropdown?.getAttribute("hidden") === null;
    if (dropdown) {
      if (expanded) {
        dropdown.hidden = true;
        notifyBtn.setAttribute("aria-expanded", "false");
      } else {
        dropdown.hidden = false;
        notifyBtn.setAttribute("aria-expanded", "true");
      }
    }
  });

  if (!notificationDocClickWired) {
    notificationDocClickWired = true;
    document.addEventListener("click", (event) => {
      const dropdownEl = document.querySelector("#notification-dropdown");
      const notifyEl = document.querySelector("#btn-notify");
      if (!dropdownEl || !notifyEl || dropdownEl.hidden) return;
      if (!dropdownEl.contains(event.target) && !notifyEl.contains(event.target)) {
        dropdownEl.hidden = true;
        notifyEl.setAttribute("aria-expanded", "false");
      }
    });
  }

  container.querySelector("#btn-notify")?.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      notifyBtn?.click();
    }
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
      requestAnimationFrame(() => {
        document.getElementById(`grid-${btn.dataset.period}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
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

  container.querySelectorAll(".goal-row[data-goal]").forEach((row) => {
    if (row.classList.contains("goal-flash")) {
      setTimeout(() => clearFlash(row.dataset.goal), 3000);
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

  // Notification center handlers
  container.querySelector("#btn-clear-notif")?.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Clear all notifications?", body: "This cannot be undone.", confirmText: "Clear" });
    if (ok) {
      clearAllNotifications();
      render(container);
    }
  });

  container.querySelector("#btn-mark-read")?.addEventListener("click", () => {
    markAllNotificationsRead();
    render(container);
  });

  container.querySelectorAll("[data-dismiss-notif]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.dismissNotif;
      const { notifications } = getNotificationCenter();
      const entry = notifications.find((n) => n.id === id);
      if (entry) {
        const brLog = getBreachLogForExport();
        const logEntry = brLog.find((le) => le.id === id);
        if (logEntry) {
          logEntry.dismissed = true;
          updateBreachLog(brLog);
        }
        render(container);
      }
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
