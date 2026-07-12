// Goals breach alerts, dismiss state, desktop notifications, status strip helpers.

import { state } from "./store.js";
import {
  evaluateAllGoals,
  evaluateAllGoalsIncludingInactive,
  getPKTDateKey,
  getPKTWeekStartKey,
  getPKTMonthKey,
  isPKTDateInCurrentPeriod,
} from "./goalsEngine.js";

let flashIds = new Set();

// ═══════════════════════════════════════════════════════════════
// BREACH LOG MANAGEMENT
// ═══════════════════════════════════════════════════════════════

const BREACH_LOG_KEY = "gj_breach_log";
const MAX_BREACH_LOG_SIZE = 30;

function getBreachLog() {
  try {
    const data = localStorage.getItem(BREACH_LOG_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveBreachLog(log) {
  try {
    localStorage.setItem(BREACH_LOG_KEY, JSON.stringify(log));
  } catch { /* ignore */ }
}

function breachIdKey(goalId, dateKey) {
  return `${goalId}_${dateKey}`;
}

function getPeriodKey(period) {
  if (period === "weekly") return getPKTWeekStartKey();
  if (period === "monthly") return getPKTMonthKey();
  return getPKTDateKey();
}

function isDateInCurrentPeriod(dateKey, period) {
  return isPKTDateInCurrentPeriod(dateKey, period);
}

function addToBreachLog(goalId, goalName, period, status, displayCurrent, displayTarget) {
  const dateKey = getPeriodKey(period);
  const id = breachIdKey(goalId, dateKey);
  const log = getBreachLog();
  
  // Check if already logged
  if (log.some((e) => e.id === id)) {
    return null; // Already logged
  }
  
  const entry = {
    id,
    goal_id: goalId,
    goal_name: goalName,
    breached_at: new Date().toISOString(),
    date_key: dateKey,
    period,
    value_at_breach: displayCurrent,
    target: displayTarget,
    notified: false,
    dismissed: false,
    read: false,
  };
  
  log.unshift(entry);
  if (log.length > MAX_BREACH_LOG_SIZE) {
    log.pop();
  }
  
  saveBreachLog(log);
  return entry;
}

function updateBreachLogEntry(id, updates) {
  const log = getBreachLog();
  const entry = log.find((e) => e.id === id);
  if (entry) {
    Object.assign(entry, updates);
    saveBreachLog(log);
  }
}

function dismissNotification(id) {
  updateBreachLogEntry(id, { dismissed: true });
}

function markNotificationAsRead(id) {
  updateBreachLogEntry(id, { read: true });
}

export function clearAllNotifications() {
  localStorage.removeItem(BREACH_LOG_KEY);
}

export function getBreachLogForExport() {
  return getBreachLog();
}

export function updateBreachLog(updatedLog) {
  saveBreachLog(updatedLog);
}

export function getNotificationCenter() {
  cleanupBreachLog();
  const log = getBreachLog().filter((e) => !e.dismissed);
  const notifications = log.filter((e) => isDateInCurrentPeriod(e.date_key, e.period));
  const unreadCount = log.filter((e) => !e.read).length;

  return {
    notifications,
    todayNotif: notifications,
    unreadCount,
    totalCount: log.length,
  };
}

export function cleanupBreachLog() {
  const todayPKT = getPKTDateKey();
  const currentMonthKey = getPKTMonthKey();
  const log = getBreachLog();
  const cleaned = log.filter((entry) => {
    if (entry.period === "daily") return entry.date_key === todayPKT;
    if (entry.period === "weekly") return isDateInCurrentPeriod(entry.date_key, "weekly");
    if (entry.period === "monthly") return entry.date_key.slice(0, 7) === currentMonthKey;
    return true;
  });
  if (cleaned.length !== log.length) {
    saveBreachLog(cleaned);
  }
}

export function markAllNotificationsRead() {
  const log = getBreachLog();
  log.forEach((e) => {
    e.read = true;
  });
  saveBreachLog(log);
}

// ═══════════════════════════════════════════════════════════════
// LEGACY DISMISS FUNCTIONS (kept for compatibility)
// ═══════════════════════════════════════════════════════════════

function today() {
  return getPKTDateKey();
}

function dismissKey(goalId) {
  return `gj-goal-dismiss-${state.user?.id}-${state.currentAccountId}-${goalId}-${today()}`;
}

export function isDismissed(goalId) {
  return localStorage.getItem(dismissKey(goalId)) === "1";
}

export function dismissBreach(goalId) {
  localStorage.setItem(dismissKey(goalId), "1");
}

export function clearDismissIfResolved(goalId) {
  localStorage.removeItem(dismissKey(goalId));
}

// ═══════════════════════════════════════════════════════════════
// EVALUATION & FILTERING
// ═══════════════════════════════════════════════════════════════

function activeEvaluations() {
  return evaluateAllGoals(state.goals.filter((g) => g.is_active));
}

export function getBreachedGoals() {
  return activeEvaluations().filter((e) => e.status === "BREACHED");
}

export function getAtRiskOrBreached() {
  return activeEvaluations().filter((e) => e.status === "AT_RISK" || e.status === "BREACHED");
}

export function getStatusStripGoals() {
  const all = activeEvaluations();
  const items = all.filter((e) => e.status === "AT_RISK" || e.status === "BREACHED");
  if (items.length) return { mode: "alerts", items };
  const decided = all.filter((e) => e.status !== "PENDING");
  if (decided.length && decided.every((e) => e.status === "MET")) {
    return { mode: "all_met", items: [] };
  }
  return { mode: "hidden", items: [] };
}

export function breachBannersHtml() {
  const todayStr = today();
  const log = getBreachLog();
  const breached = getBreachedGoals();
  
  // Only show banners for today's breaches that aren't dismissed
  const bannersToShow = breached.filter((e) => {
    const entry = log.find((le) => le.goal_id === e.goal.id && isDateInCurrentPeriod(le.date_key, le.period) && !le.dismissed);
    return entry !== undefined;
  });
  
  if (!bannersToShow.length) return "";
  return bannersToShow.map((e) => `
    <div class="goal-breach-banner" data-goal-id="${e.goal.id}">
      <span class="gbb-icon"><i data-lucide="alert-triangle"></i></span>
      <span class="gbb-text">⚠️ GOAL BREACHED: ${escapeBanner(e.goal.title)} (${e.displayCurrent}/${e.displayTarget}). Consider stopping for today.</span>
      <button class="gbb-dismiss" data-dismiss-goal="${e.goal.id}" aria-label="Dismiss">&times;</button>
    </div>`).join("");
}

export function goalsStatusStripHtml() {
  const strip = getStatusStripGoals();
  if (strip.mode === "hidden") return "";
  if (strip.mode === "all_met") {
    return `<div class="goals-status-strip goals-all-ok glass"><i data-lucide="check-circle"></i> All goals on track</div>`;
  }
  return `<div class="goals-status-strip glass">
    ${strip.items.map((e) => `
      <button class="goal-pill goal-pill-${e.status.toLowerCase()}" data-go-goals title="View Goals">
        ${escapeBanner(e.goal.title)}: ${e.displayCurrent} / ${e.displayTarget}
      </button>`).join("")}
  </div>`;
}

function escapeBanner(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

export function wireGoalsTradeLog(container) {
  container.querySelectorAll("[data-dismiss-goal]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const goalId = btn.dataset.dismissGoal;
      
      // Find and update the breach log entry for the current period
      const log = getBreachLog();
      const entry = log.find((le) => le.goal_id === goalId && isDateInCurrentPeriod(le.date_key, le.period));
      if (entry) {
        entry.dismissed = true;
        updateBreachLog(log);
      }
      
      // Also keep legacy flag for compatibility
      dismissBreach(goalId);
      
      const banner = btn.closest(".goal-breach-banner");
      banner?.remove();
    });
  });
  
  container.querySelectorAll("[data-go-goals]").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("gj:navigate", { detail: { page: "goals" } }));
    });
  });
}

export function processGoalNotifications() {
  cleanupBreachLog();
  const breached = getBreachedGoals().filter((e) => e.goal.notify_on_breach);
  
  for (const e of breached) {
    const goalId = e.goal.id;
    const periodKey = getPeriodKey(e.goal.period);
    const brId = breachIdKey(goalId, periodKey);
    
    // Add to log if not already there
    let logEntry = getBreachLog().find((le) => le.id === brId);
    if (!logEntry) {
      logEntry = addToBreachLog(goalId, e.goal.title, e.goal.period, "BREACHED", e.displayCurrent, e.displayTarget);
    }
    
    // Fire browser notification only if not yet notified
    if (logEntry && !logEntry.notified && Notification?.permission === "granted") {
      try {
        new Notification(`${e.goal.title} breached — Gold Journal`, {
          body: `${e.displayCurrent} vs ${e.displayTarget} target`,
          icon: "/icons/icon-192.png",
        });
        updateBreachLogEntry(brId, { notified: true });
      } catch { /* ignore */ }
    }
    
    // Flash the card if not dismissed
    if (logEntry && !logEntry.dismissed) {
      flashIds.add(goalId);
    }
  }
  
  for (const ev of activeEvaluations()) {
    if (ev.status !== "BREACHED") {
      clearDismissIfResolved(ev.goal.id);
      flashIds.delete(ev.goal.id);
    }
  }
}

export function shouldFlashCard(goalId) {
  return flashIds.has(goalId);
}

export function clearFlash(goalId) {
  flashIds.delete(goalId);
}

export function notificationPermission() {
  return typeof Notification !== "undefined" ? Notification.permission : "unsupported";
}

export async function requestNotificationPermission() {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return Notification.requestPermission();
}

export function evaluationsForPage(periodFilter = "all") {
  const goals = state.goals;
  const evaluated = evaluateAllGoalsIncludingInactive(goals);
  if (periodFilter === "all") return evaluated;
  return evaluated.filter((e) => e.goal.period === periodFilter);
}
