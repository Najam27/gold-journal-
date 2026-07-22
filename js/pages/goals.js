import {
  state, currentAccount, saveGoal, deleteGoal, toggleGoalActive,
} from "../store.js";
import {
  evaluationsForPage, notificationPermission, requestNotificationPermission,
  shouldFlashCard, clearFlash, processGoalNotifications, refreshGoalAlerts,
  getNotificationCenter, clearAllNotifications, markAllNotificationsRead, getBreachLogForExport, updateBreachLog,
} from "../goalsAlerts.js";
import {
  listPastMonths, monthHistory, customTrackToType, comparisonFromDirection,
  periodRange, GOAL_TYPES,
  getPKTDate, getPKTDateKey,
} from "../goalsEngine.js";
import { toast, confirmDialog, escapeHtml } from "../ui.js";
import { openModal } from "../modal.js";

let activePeriodAnchor = "all";
let activeStatusFilter = "all";
let goalSearchTerm = "";
let recalcTimer = null;
let expandedMonths = new Set();
let goalsContainer = null;
let eventsWired = false;

const PERIODS = ["daily", "weekly", "monthly"];
const PERIOD_TABS = ["all", ...PERIODS];
const PERIOD_LABELS = { daily: "Daily Goals", weekly: "Weekly Goals", monthly: "Monthly Goals" };
const PERIOD_HINTS = {
  daily: "Resets every midnight",
  weekly: "Resets every Monday 00:00 PKT",
  monthly: "Resets every 1st of month PKT",
};
const PERIOD_ICONS = { daily: "sun", weekly: "calendar-range", monthly: "calendar" };

const TRACK_HINTS = {
  pnl: "Enter dollar amount e.g. 500 for $500 profit target",
  count: "Enter max number of trades allowed",
  win_rate: "Enter percentage e.g. 50 for 50%",
  rr: "Enter ratio e.g. 1.5 means 1:1.5",
  loss: "Enter max loss amount in dollars",
  patience: "Enter minimum average score (1-5)",
  drawdown: "Enter max drawdown percentage e.g. 10 for 10%",
  profit_factor: "Enter minimum profit factor e.g. 1.5",
  log_same_day: "Enter minimum same-day logging percentage e.g. 90",
};

export function render(container) {
  goalsContainer = container;
  processGoalNotifications();
  markGoalsNotificationsRead();

  const acc = currentAccount();
  const evaluated = evaluationsForPage("all");
  const stats = computeSummaryStats(evaluated);
  const filtered = filterEvaluations(evaluated);

  container.innerHTML = `
  <div class="goals-page">
    <div class="page-head goals-header-row">
      <div>
        <h1 class="page-title">Goals</h1>
        <p class="page-sub">${escapeHtml(acc?.name || "Account")} - discipline targets update automatically from your journal data.</p>
      </div>
      <div class="page-actions goals-header-actions">
        <div class="notify-wrap">
          ${notificationBellHtml()}
          <div class="notification-dropdown" id="notification-dropdown" hidden>
            ${notificationDropdownHtml()}
          </div>
        </div>
        <button class="btn btn-gold" id="btn-add-goal"><i data-lucide="plus"></i> Add Custom Goal</button>
      </div>
    </div>

    <div class="goals-summary-cards" id="goals-summary-stats">
      ${summaryStatsHtml(stats)}
    </div>

    ${alertsPanelHtml(evaluated)}

    <div class="goals-control-bar glass">
      <div class="goals-period-tabs" role="tablist" aria-label="Goal periods">
        ${PERIOD_TABS.map((p) => {
          const label = p === "all" ? "All" : p.charAt(0).toUpperCase() + p.slice(1);
          return `<button type="button" class="goals-period-tab ${activePeriodAnchor === p ? "active" : ""}" data-period="${p}">${label}</button>`;
        }).join("")}
      </div>
      <div class="goals-filters">
        <div class="search-box goals-search">
          <i data-lucide="search"></i>
          <input type="search" id="goal-search" placeholder="Search goals" value="${escapeHtml(goalSearchTerm)}">
        </div>
        <select class="mini-select" id="goal-status-filter" aria-label="Filter by status">
          ${statusOptionsHtml()}
        </select>
      </div>
    </div>

    <div class="goals-sections" id="goals-sections">
      ${sectionsHtml(filtered)}
    </div>

    <div class="goals-history glass card-pad">
      <div class="gh-head">
        <h6><i data-lucide="history"></i> Past Periods</h6>
        <span class="count-badge">${listPastMonths(6).length} months</span>
      </div>
      <div id="past-months">${pastMonthsHtml()}</div>
    </div>

    <p class="goals-notify-note note"><i data-lucide="info"></i> Notifications only work while this browser tab is open.</p>
  </div>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  animateSummaryStats(container);
  wire(container);
  startRecalcTimer(container);
}

function statusKey(status) {
  return String(status || "pending").toLowerCase().replace("_", "-");
}

function filterEvaluations(evaluated) {
  const q = goalSearchTerm.trim().toLowerCase();
  return evaluated.filter((e) => {
    const g = e.goal;
    if (activePeriodAnchor !== "all" && g.period !== activePeriodAnchor) return false;
    if (activeStatusFilter !== "all") {
      const status = e.inactive ? "paused" : statusKey(e.status);
      if (status !== activeStatusFilter) return false;
    }
    if (!q) return true;
    const haystack = [
      g.title,
      g.period,
      g.type,
      GOAL_TYPES[g.type],
      goalDescription(g),
      e.displayCurrent,
      e.displayTarget,
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });
}

function statusOptionsHtml() {
  const options = [
    ["all", "All statuses"],
    ["met", "Met"],
    ["at-risk", "At risk"],
    ["breached", "Breached"],
    ["pending", "Pending"],
    ["paused", "Paused"],
  ];
  return options.map(([value, label]) =>
    `<option value="${value}" ${activeStatusFilter === value ? "selected" : ""}>${label}</option>`
  ).join("");
}

function alertsPanelHtml(evaluated) {
  const alerts = evaluated.filter((e) => e.goal.is_active && (e.status === "BREACHED" || e.status === "AT_RISK"));
  if (!alerts.length) {
    return `
    <div class="goals-alert-panel goals-alert-ok glass">
      <i data-lucide="shield-check"></i>
      <div>
        <strong>All active goals are under control</strong>
        <span>No active breach or risk warning in the current period.</span>
      </div>
    </div>`;
  }
  return `
  <div class="goals-alert-panel glass">
    <div class="goals-alert-title"><i data-lucide="alert-triangle"></i> Needs attention</div>
    <div class="goals-alert-list">
      ${alerts.slice(0, 4).map((e) => `
        <button type="button" class="goals-alert-chip goals-alert-${statusKey(e.status)}" data-jump-goal="${e.goal.id}">
          <span>${escapeHtml(e.goal.title)}</span>
          <b>${escapeHtml(e.displayCurrent)} / ${escapeHtml(e.displayTarget)}</b>
        </button>`).join("")}
    </div>
  </div>`;
}

function markGoalsNotificationsRead() {
  const { notifications } = getNotificationCenter();
  if (!notifications.length) return;
  const log = getBreachLogForExport();
  let changed = false;
  for (const n of notifications) {
    const entry = log.find((e) => e.id === n.id);
    if (entry && !entry.read) {
      entry.read = true;
      changed = true;
    }
  }
  if (changed) updateBreachLog(log);
}

function computeSummaryStats(evaluated) {
  const activeGoals = evaluated.filter((e) => e.goal.is_active);
  return {
    active: activeGoals.length,
    met: activeGoals.filter((e) => e.status === "MET").length,
    breached: activeGoals.filter((e) => e.status === "BREACHED").length,
    atRisk: activeGoals.filter((e) => e.status === "AT_RISK").length,
  };
}

const SUMMARY_CARDS = [
  { key: "active", label: "Total Active Goals", icon: "target", color: "#f3f4f6" },
  { key: "met", label: "Met", icon: "check-circle", color: "#22c55e" },
  { key: "breached", label: "Breached", icon: "alert-triangle", color: "#ef4444" },
  { key: "atRisk", label: "At Risk", icon: "alert-circle", color: "#f59e0b" },
];

function summaryStatsHtml(stats) {
  return SUMMARY_CARDS.map((card) => `
    <div class="goals-card">
      <div class="goals-card-top">
        <i data-lucide="${card.icon}" style="color:${card.color}"></i>
        <div class="goals-card-num" data-count="${stats[card.key]}" style="color:${card.color}">0</div>
      </div>
      <div class="goals-card-label">${card.label}</div>
    </div>`).join("");
}

function animateSummaryStats(container) {
  container.querySelectorAll(".goals-card-num[data-count]").forEach((el) => {
    const target = Number(el.dataset.count) || 0;
    const duration = 500;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      el.textContent = String(Math.round(target * t));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function notificationBellHtml() {
  const perm = notificationPermission();
  const { unreadCount } = getNotificationCenter();
  const badge = unreadCount > 0 ? `<span class="notify-count">${unreadCount}</span>` : "";
  const blocked = perm === "denied"
    ? `<span class="notify-state blocked">blocked</span>`
    : "";
  return `
    <button type="button" class="btn btn-ghost btn-sm notify-toggle ${perm === "denied" ? "blocked" : ""}" id="btn-notify" title="Notifications" aria-expanded="false">
      <span class="notify-icon">
        <i data-lucide="bell"></i>
        ${badge}
      </span>
      ${blocked}
    </button>`;
}

function sectionsHtml(items) {
  if (!items.length) {
    return `
    <div class="empty-state big goals-empty glass">
      <i data-lucide="target"></i>
      <p>No goals match your filters.</p>
    </div>`;
  }
  return PERIODS
    .filter((p) => activePeriodAnchor === "all" || activePeriodAnchor === p)
    .map((p) => sectionHtml(p, items.filter((e) => e.goal.period === p)))
    .join("");
}

function sectionHtml(period, items) {
  const activeCount = items.filter((e) => e.goal.is_active).length;
  return `
  <section class="goals-section" id="section-${period}" data-section="${period}">
    <div class="goals-section-head">
      <div>
        <span class="goals-section-title"><i data-lucide="${PERIOD_ICONS[period]}"></i> <strong>${PERIOD_LABELS[period]}</strong></span>
        <span class="goals-section-hint">${PERIOD_HINTS[period]}</span>
      </div>
      <span class="count-badge">${activeCount} active</span>
    </div>
    <div class="goals-grid" id="grid-${period}">
      ${items.length ? items.map(goalCard).join("") : `<div class="empty-state small"><p>No goals in this period.</p></div>`}
    </div>
  </section>`;
}

function goalDescription(g) {
  const map = {
    max_trades: "Max trades per day",
    max_loss_day: "Max loss today",
    max_loss_week: "Max weekly loss",
    no_revenge_trade: "Min gap after loss",
    profit_target: "Net P&L target",
    win_rate: "Win rate this period",
    min_rr: "Avg R:R achieved",
    setup_quality: "% A/A+ setups",
    patience_score: "Avg patience score",
    screenshot_rate: "% trades with screenshot",
    max_consecutive_losses: "Max loss streak",
    weekly_review: "Reviews logged",
    profit_factor: "Gross win / gross loss",
    drawdown_pct: "Max drawdown",
    log_same_day: "Same-day logging rate",
    custom: "Custom goal",
  };
  return map[g.type] || "Custom goal";
}

function countRevengeIncidents(minMinutes) {
  const byDay = new Map();
  for (const t of state.trades) {
    if (!t.created_at) continue;
    if (!byDay.has(t.trade_date)) byDay.set(t.trade_date, []);
    byDay.get(t.trade_date).push(t);
  }
  let count = 0;
  for (const dayTrades of byDay.values()) {
    const sorted = dayTrades.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].result !== "Loss") continue;
      const gap = (new Date(sorted[i + 1].created_at) - new Date(sorted[i].created_at)) / 60000;
      if (gap < minMinutes) count += 1;
    }
  }
  return count;
}

function goalCard(ev) {
  const g = ev.goal;
  const flash = shouldFlashCard(g.id) && ev.status === "BREACHED";
  const status = ev.inactive ? "paused" : statusKey(ev.status);
  const barClass = ev.status === "MET" ? "bar-met" : ev.status === "BREACHED" ? "bar-breach" : ev.status === "AT_RISK" ? "bar-risk" : "bar-pending";
  const progress = Math.min(100, Math.max(0, ev.progress || 0));
  const range = periodRange(g.period);
  const typeLabel = GOAL_TYPES[g.type] || "Custom";

  let targetDisplay;
  if (g.type === "no_revenge_trade" && ev.status === "BREACHED") {
    const count = countRevengeIncidents(Number(g.target_value) || 30);
    targetDisplay = `<span class="target-breached">${count} revenge trade${count === 1 ? "" : "s"}</span>`;
  } else {
    const cls = ev.status === "BREACHED" ? "target-breached" : ev.status === "MET" ? "target-met" : "target-pending";
    targetDisplay = `<span class="${cls}">${ev.displayCurrent} / ${ev.displayTarget}</span>`;
  }

  const badgeLabel = ev.inactive ? "PAUSED" : ev.status.replace("_", " ");
  const directionLabel = g.comparison === "lte" ? "Keep under" : g.comparison === "gte" ? "Reach at least" : "Match";
  const stateText = ev.inactive
    ? "This goal is paused and will not trigger alerts."
    : ev.status === "PENDING"
      ? "Waiting for enough journal data in this period."
      : ev.status === "BREACHED"
        ? ev.message
        : ev.status === "AT_RISK"
          ? "Close to the limit. Review before taking the next trade."
          : "Goal is on track for the current period.";

  return `
  <article class="goal-card goal-state-${status} ${flash ? "goal-flash" : ""} ${!g.is_active ? "goal-inactive" : ""}" data-goal="${g.id}">
    <div class="goal-card-head">
      <div class="goal-card-icon"><i data-lucide="${PERIOD_ICONS[g.period] || "target"}"></i></div>
      <div class="goal-card-title-wrap">
        <h3>${escapeHtml(g.title)}</h3>
        <span>${escapeHtml(typeLabel)} - ${escapeHtml(goalDescription(g))}</span>
      </div>
      <span class="goal-badge goal-badge-${status}">${badgeLabel}</span>
    </div>

    <div class="goal-metric-row">
      <div>
        <span class="goal-kicker">Current</span>
        <strong class="goal-current">${targetDisplay}</strong>
      </div>
      <div>
        <span class="goal-kicker">Rule</span>
        <strong>${escapeHtml(directionLabel)}</strong>
      </div>
    </div>

    <div class="goal-progress-wrap">
      <div class="goal-progress-bar">
        <span class="goal-bar-fill ${barClass}" style="width:${progress}%"></span>
      </div>
      <div class="goal-progress-meta">
        <span>${Math.round(progress)}% progress</span>
        <span>${escapeHtml(range.start)} to ${escapeHtml(range.end)}</span>
      </div>
    </div>

    <p class="goal-state-note">${escapeHtml(stateText)}</p>

    <div class="goal-card-foot">
      <span class="goal-kind">${g.is_default ? "System goal" : "Custom goal"}</span>
      <div class="goal-actions">
      <label class="goal-switch" title="${g.is_active ? "Deactivate" : "Activate"}">
        <input type="checkbox" data-toggle="${g.id}" ${g.is_active ? "checked" : ""}>
        <span class="goal-switch-ui"></span>
      </label>
      <button type="button" class="ic-btn" data-edit="${g.id}" title="Edit"><i data-lucide="pencil"></i></button>
      ${!g.is_default ? `<button type="button" class="ic-btn danger" data-del="${g.id}" title="Delete"><i data-lucide="trash-2"></i></button>` : ""}
      </div>
    </div>
  </article>`;
}

function pastMonthsHtml() {
  const months = listPastMonths(6);
  if (!months.length) return `<p class="muted small">No past months yet.</p>`;
  return `
  <table class="past-months-table">
    <thead>
      <tr>
        <th>Month</th>
        <th>Goals Met</th>
        <th>Progress</th>
        <th>Expand</th>
      </tr>
    </thead>
    <tbody>
      ${months.map(({ year, month }) => {
        const label = new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
        const hist = monthHistory(state.goals, year, month);
        const key = `${year}-${month}`;
        const open = expandedMonths.has(key);
        const pct = hist.total > 0 ? Math.round((hist.met / hist.total) * 100) : 0;

        if (hist.noData) {
          return `
          <tr class="past-month-row past-month-row-nodata">
            <td class="pm-month-label"><span class="pm-month-muted">${label}</span></td>
            <td class="pm-success"><em class="pm-no-data">No data</em></td>
            <td class="pm-progress">
              <div class="past-month-bar"><span class="past-month-bar-fill bar-pending" style="width:0"></span></div>
            </td>
            <td class="pm-expand-cell"></td>
          </tr>`;
        }

        return `
        <tr class="past-month-row">
          <td class="pm-month-label">${label}</td>
          <td class="pm-success">${hist.met} / ${hist.total}</td>
          <td class="pm-progress">
            <div class="past-month-bar"><span class="past-month-bar-fill" style="width:${pct}%"></span></div>
          </td>
          <td class="pm-expand-cell">
            <button type="button" class="pm-expand-btn" data-month="${key}" title="View details" aria-expanded="${open}">
              <i data-lucide="chevron-${open ? "down" : "right"}"></i>
            </button>
          </td>
        </tr>
        ${open ? `<tr class="pm-details-row"><td colspan="4"><div class="pm-details">
          ${hist.results.map((r) => `
          <div class="pm-goal pm-${r.status.toLowerCase()}">
            <span>${escapeHtml(r.goal.title)}</span>
            <span class="goal-badge badge-${statusKey(r.status)}">${r.status}</span>
          </div>`).join("")}
        </div></td></tr>` : ""}`;
      }).join("")}
    </tbody>
  </table>`;
}

function notificationDropdownHtml() {
  const perm = notificationPermission();
  const { notifications, unreadCount } = getNotificationCenter();

  const formatTime = (isoStr) => {
    const date = getPKTDate(new Date(isoStr));
    const now = getPKTDate();
    const todayKey = getPKTDateKey(now);
    const dateKey = date.toISOString().slice(0, 10);
    const timeLabel = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });
    if (dateKey === todayKey) return `Today ${timeLabel}`;
    const yesterdayKey = getPKTDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    if (dateKey === yesterdayKey) return `Yesterday ${timeLabel}`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ` ${timeLabel}`;
  };

  const enableBtn = perm === "default"
    ? `<button type="button" class="btn btn-gold btn-sm nc-enable-btn" id="btn-enable-notify">Enable desktop notifications</button>`
    : perm === "denied"
      ? `<p class="nc-perm-denied">Notifications blocked in browser settings</p>`
      : "";

  const listHtml = notifications.length
    ? notifications.map((n) => `
      <div class="nc-item nc-item-breached" data-notif-id="${n.id}">
        <span class="nc-icon"><i data-lucide="alert-triangle"></i></span>
        <div class="nc-content">
          <div class="nc-content-head">
            <span class="nc-goal-name">${escapeHtml(n.goal_name)}</span>
            <span class="nc-time">${formatTime(n.breached_at)}</span>
          </div>
          <div class="nc-message">${escapeHtml(n.value_at_breach)} / ${escapeHtml(n.target)}</div>
        </div>
        <button type="button" class="nc-dismiss" data-dismiss-notif="${n.id}" title="Dismiss" aria-label="Dismiss">
          <i data-lucide="x"></i>
        </button>
      </div>`).join("")
    : `<div class="nc-empty"><i data-lucide="check-circle"></i><p>No active alerts</p></div>`;

  return `
  <div class="nc-head">
    <div class="nc-head-left">
      <h6><i data-lucide="bell"></i> Notifications</h6>
      ${unreadCount > 0 ? `<span class="nc-badge">${unreadCount} new</span>` : ""}
    </div>
    <div class="nc-head-actions">
      <button type="button" class="nc-btn nc-btn-sm" id="btn-mark-read">Mark all read</button>
      <button type="button" class="nc-btn nc-btn-sm" id="btn-clear-notif">Clear all</button>
    </div>
  </div>
  ${enableBtn}
  <div class="nc-list">${listHtml}</div>`;
}

function refreshGoalsContent(container) {
  const evaluated = evaluationsForPage("all");
  const stats = computeSummaryStats(evaluated);
  const filtered = filterEvaluations(evaluated);

  const statsEl = container.querySelector("#goals-summary-stats");
  if (statsEl) {
    statsEl.innerHTML = summaryStatsHtml(stats);
    animateSummaryStats(container);
  }

  const alertEl = container.querySelector(".goals-alert-panel");
  if (alertEl) {
    alertEl.outerHTML = alertsPanelHtml(evaluated);
  }

  const sectionsEl = container.querySelector("#goals-sections");
  if (sectionsEl) {
    sectionsEl.innerHTML = sectionsHtml(filtered);
  }

  const bellWrap = container.querySelector(".notify-wrap");
  if (bellWrap) {
    const dropdown = bellWrap.querySelector("#notification-dropdown");
    const wasOpen = dropdown && !dropdown.hidden;
    bellWrap.innerHTML = `${notificationBellHtml()}<div class="notification-dropdown" id="notification-dropdown" ${wasOpen ? "" : "hidden"}>${notificationDropdownHtml()}</div>`;
  }

  const pastEl = container.querySelector("#past-months");
  if (pastEl) pastEl.innerHTML = pastMonthsHtml();

  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  wire(container);
}

function wire(container) {
  container.querySelector("#btn-add-goal")?.addEventListener("click", () => openCustomGoalModal(container));

  const notifyBtn = container.querySelector("#btn-notify");
  const dropdown = container.querySelector("#notification-dropdown");

  notifyBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!dropdown) return;
    const open = dropdown.hidden;
    dropdown.hidden = !open;
    notifyBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  container.querySelector("#btn-enable-notify")?.addEventListener("click", async () => {
    await requestNotificationPermission();
    refreshGoalsContent(container);
  });

  container.querySelectorAll(".goals-period-tab[data-period]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activePeriodAnchor = btn.dataset.period;
      refreshGoalsContent(container);
    });
  });

  container.querySelector("#goal-search")?.addEventListener("input", (event) => {
    goalSearchTerm = event.target.value;
    refreshGoalsContent(container);
    container.querySelector("#goal-search")?.focus();
  });

  container.querySelector("#goal-status-filter")?.addEventListener("change", (event) => {
    activeStatusFilter = event.target.value;
    refreshGoalsContent(container);
  });

  container.querySelectorAll("[data-jump-goal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      activePeriodAnchor = "all";
      activeStatusFilter = "all";
      goalSearchTerm = "";
      refreshGoalsContent(container);
      requestAnimationFrame(() => {
        document.querySelector(`[data-goal="${btn.dataset.jumpGoal}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  });

  container.querySelectorAll("[data-toggle]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      try {
        await toggleGoalActive(cb.dataset.toggle, cb.checked);
        refreshGoalAlerts();
        refreshGoalsContent(container);
      } catch (err) { toast(err.message, "error"); cb.checked = !cb.checked; }
    });
  });

  container.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const g = state.goals.find((x) => x.id === btn.dataset.edit);
      if (g) openEditModal(g, container);
    });
  });

  container.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog({ title: "Delete goal?", body: "This custom goal will be permanently removed.", confirmText: "Delete" });
      if (!ok) return;
      try {
        await deleteGoal(btn.dataset.del);
        toast("Goal deleted.", "success");
        refreshGoalAlerts();
        render(container);
      } catch (err) { toast(err.message, "error"); }
    });
  });

  container.querySelectorAll(".goal-card.goal-flash").forEach((row) => {
    setTimeout(() => clearFlash(row.dataset.goal), 3000);
  });

  container.querySelectorAll("[data-month]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.month;
      if (expandedMonths.has(key)) expandedMonths.delete(key);
      else expandedMonths.add(key);
      refreshGoalsContent(container);
    });
  });

  container.querySelector("#btn-clear-notif")?.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Clear all notifications?", body: "This cannot be undone.", confirmText: "Clear" });
    if (!ok) return;
    clearAllNotifications();
    refreshGoalsContent(container);
  });

  container.querySelector("#btn-mark-read")?.addEventListener("click", () => {
    markAllNotificationsRead();
    refreshGoalsContent(container);
  });

  container.querySelectorAll("[data-dismiss-notif]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.dismissNotif;
      const brLog = getBreachLogForExport();
      const logEntry = brLog.find((le) => le.id === id);
      if (logEntry) {
        logEntry.dismissed = true;
        updateBreachLog(brLog);
        refreshGoalAlerts();
        refreshGoalsContent(container);
      }
    });
  });
}

function wireGlobalEvents() {
  if (eventsWired) return;
  eventsWired = true;

  document.addEventListener("click", (event) => {
    const dropdownEl = document.querySelector("#notification-dropdown");
    const notifyEl = document.querySelector("#btn-notify");
    if (!dropdownEl || !notifyEl || dropdownEl.hidden) return;
    if (!dropdownEl.contains(event.target) && !notifyEl.contains(event.target)) {
      dropdownEl.hidden = true;
      notifyEl.setAttribute("aria-expanded", "false");
    }
  });

  window.addEventListener("gj:goals-updated", () => {
    if (goalsContainer?.querySelector(".goals-page")) {
      refreshGoalsContent(goalsContainer);
    }
  });

  window.addEventListener("gj:trades-changed", () => {
    refreshGoalAlerts();
  });
}

wireGlobalEvents();

function startRecalcTimer(container) {
  if (recalcTimer) clearInterval(recalcTimer);
  recalcTimer = setInterval(() => {
    if (container.querySelector(".goals-page")) {
      processGoalNotifications();
      refreshGoalsContent(container);
    } else {
      processGoalNotifications();
    }
  }, 5 * 60 * 1000);
}

function openEditModal(goal, container) {
  const isDefault = goal.is_default;
  const bodyHtml = `
  <form id="edit-goal-form" class="modal-form">
    ${isDefault ? `<p class="modal-info-note">This is a system goal. You can change the target value and notification setting only.</p>` : ""}
    <label class="field">
      <span>Goal name</span>
      <input type="text" name="title" value="${escapeHtml(goal.title)}" ${isDefault ? "readonly" : ""} required>
      <span class="field-error" data-err="title"></span>
    </label>
    <label class="field">
      <span>Target value</span>
      <input type="number" step="any" name="target_value" value="${goal.target_value}" required>
      <span class="field-error" data-err="target_value"></span>
    </label>
    <label class="field">
      <span>Period</span>
      ${isDefault
        ? `<input type="text" value="${goal.period.charAt(0).toUpperCase() + goal.period.slice(1)}" readonly>`
        : `<select name="period">
            <option value="daily" ${goal.period === "daily" ? "selected" : ""}>Daily</option>
            <option value="weekly" ${goal.period === "weekly" ? "selected" : ""}>Weekly</option>
            <option value="monthly" ${goal.period === "monthly" ? "selected" : ""}>Monthly</option>
          </select>`}
    </label>
    ${!isDefault ? `
    <label class="field">
      <span>Direction</span>
      <select name="direction">
        <option value="above" ${goal.comparison === "gte" ? "selected" : ""}>Must be above (minimum target)</option>
        <option value="below" ${goal.comparison === "lte" ? "selected" : ""}>Must be below (maximum limit)</option>
      </select>
    </label>` : ""}
    <label class="field">
      <span>Notify on breach</span>
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
    clearFieldErrors(form);
    const fd = new FormData(form);
    const title = String(fd.get("title") || "").trim();
    const targetRaw = fd.get("target_value");
    const targetNum = Number(targetRaw);
    let valid = true;
    if (!title) { showFieldError(form, "title", "Goal name is required."); valid = false; }
    if (targetRaw === "" || Number.isNaN(targetNum)) { showFieldError(form, "target_value", "Enter a valid number."); valid = false; }
    if (!valid) return;

    try {
      const payload = {
        title,
        target_value: targetNum,
        notify_on_breach: !!fd.get("notify_on_breach"),
      };
      if (!isDefault) {
        payload.period = fd.get("period");
        payload.comparison = comparisonFromDirection(fd.get("direction"));
      }
      await saveGoal(payload, goal.id);
      toast("Goal updated.", "success");
      m.close();
      refreshGoalAlerts();
      refreshGoalsContent(container);
    } catch (err) { toast(err.message, "error"); }
  });
}

function openCustomGoalModal(container) {
  const bodyHtml = `
  <form id="custom-goal-form" class="modal-form">
    <label class="field">
      <span>Goal name</span>
      <input type="text" name="title" placeholder="My custom goal" required>
      <span class="field-error" data-err="title"></span>
    </label>
    <label class="field">
      <span>Period</span>
      <select name="period">
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
      </select>
    </label>
    <label class="field">
      <span>What to track</span>
      <select name="track" id="custom-track">
        <option value="pnl">Net P&L</option>
        <option value="count">Trade Count</option>
        <option value="win_rate">Win Rate %</option>
        <option value="rr">Avg R:R</option>
        <option value="loss">Loss Amount</option>
        <option value="patience">Patience Score</option>
        <option value="drawdown">Drawdown %</option>
        <option value="profit_factor">Profit Factor</option>
        <option value="log_same_day">Same-Day Logging %</option>
      </select>
    </label>
    <label class="field">
      <span>Target value</span>
      <input type="number" step="any" name="target_value" required>
      <span class="field-hint" id="track-hint">${TRACK_HINTS.pnl}</span>
      <span class="field-error" data-err="target_value"></span>
    </label>
    <label class="field">
      <span>Direction</span>
      <select name="direction">
        <option value="above">Must be above (minimum target)</option>
        <option value="below">Must be below (maximum limit)</option>
      </select>
    </label>
    <label class="field">
      <span>Notify on breach</span>
      <label class="goal-switch inline"><input type="checkbox" name="notify_on_breach" checked><span class="goal-switch-ui"></span></label>
    </label>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-cancel>Cancel</button>
      <button type="submit" class="btn btn-gold">Save</button>
    </div>
  </form>`;

  const m = openModal({ title: "Add Custom Goal", bodyHtml });
  const form = m.body.querySelector("#custom-goal-form");
  const trackSel = form.querySelector("#custom-track");
  const hintEl = form.querySelector("#track-hint");
  trackSel.addEventListener("change", () => {
    hintEl.textContent = TRACK_HINTS[trackSel.value] || TRACK_HINTS.custom;
  });

  form.querySelector("[data-cancel]").addEventListener("click", m.close);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFieldErrors(form);
    const fd = new FormData(form);
    const title = String(fd.get("title") || "").trim();
    const targetRaw = fd.get("target_value");
    const targetNum = Number(targetRaw);
    const period = fd.get("period");
    const track = fd.get("track");
    let valid = true;
    if (!title) { showFieldError(form, "title", "Goal name is required."); valid = false; }
    if (targetRaw === "" || Number.isNaN(targetNum)) { showFieldError(form, "target_value", "Enter a valid number."); valid = false; }
    if (!valid) return;

    const type = customTrackToType(track, period);
    try {
      await saveGoal({
        title,
        type,
        period,
        target_value: targetNum,
        comparison: comparisonFromDirection(fd.get("direction")),
        is_active: true,
        is_default: false,
        notify_on_breach: !!fd.get("notify_on_breach"),
      });
      toast("Goal created.", "success");
      m.close();
      refreshGoalAlerts();
      activePeriodAnchor = period;
      activeStatusFilter = "all";
      goalSearchTerm = "";
      render(container);
      requestAnimationFrame(() => {
        document.getElementById(`section-${period}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (err) { toast(err.message, "error"); }
  });
}

function showFieldError(form, field, msg) {
  const el = form.querySelector(`[data-err="${field}"]`);
  if (el) el.textContent = msg;
}

function clearFieldErrors(form) {
  form.querySelectorAll(".field-error").forEach((el) => { el.textContent = ""; });
}
