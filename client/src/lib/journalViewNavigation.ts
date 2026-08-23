export const JOURNAL_VIEW_EVENT = "gold-journal:view";

export type JournalViewTarget = "trades" | "missed" | "analysis" | "goals" | "calendar" | "plan" | "mentor" | "mt5" | "risk" | "options";

export function openJournalView(view: JournalViewTarget) {
  window.dispatchEvent(new CustomEvent(JOURNAL_VIEW_EVENT, { detail: { view } }));
}
