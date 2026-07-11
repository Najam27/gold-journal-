// Goals breach alerts, dismiss state, desktop notifications, status strip helpers.

import { state } from "./store.js";
import { evaluateAllGoals, evaluateAllGoalsIncludingInactive } from "./goalsEngine.js";

const SESSION_NOTIFIED = new Set();
let flashIds = new Set();

function dismissKey(goalId) {
  const today = new Date().toISOString().slice(0, 10);
  return `gj-goal-dismiss-${state.user?.id}-${state.currentAccountId}-${goalId}-${today}`;
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
  const breached = getBreachedGoals().filter((e) => !isDismissed(e.goal.id));
  if (!breached.length) return "";
  return breached.map((e) => `
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
      dismissBreach(btn.dataset.dismissGoal);
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
  const breached = getBreachedGoals().filter((e) => e.goal.notify_on_breach);
  for (const e of breached) {
    const id = e.goal.id;
    if (!SESSION_NOTIFIED.has(id) && Notification?.permission === "granted") {
      try {
        new Notification(`${e.goal.title} breached — Gold Journal`, {
          body: `${e.displayCurrent} vs ${e.displayTarget} target`,
          icon: "/icons/icon-192.png",
        });
        SESSION_NOTIFIED.add(id);
      } catch { /* ignore */ }
    }
    if (!isDismissed(id)) flashIds.add(id);
  }
  for (const ev of activeEvaluations()) {
    if (ev.status !== "BREACHED") {
      clearDismissIfResolved(ev.goal.id);
      SESSION_NOTIFIED.delete(ev.goal.id);
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
