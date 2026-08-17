let selectedAccountId: number | undefined;
const listeners = new Set<(accountId: number | undefined) => void>();

export function getSelectedAccountId() {
  if (selectedAccountId !== undefined) return selectedAccountId;
  if (typeof window === "undefined") return undefined;
  const stored = Number(window.sessionStorage.getItem("gj_active_account_id"));
  return stored || undefined;
}

export function setSelectedAccountId(accountId: number | undefined) {
  selectedAccountId = accountId;
  if (typeof window !== "undefined") {
    if (accountId) window.sessionStorage.setItem("gj_active_account_id", String(accountId));
    else window.sessionStorage.removeItem("gj_active_account_id");
  }
  listeners.forEach(listener => listener(accountId));
}

export function subscribeSelectedAccount(listener: (accountId: number | undefined) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
