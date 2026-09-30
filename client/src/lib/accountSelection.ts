let selectedAccountId: number | undefined;
const listeners = new Set<(accountId: number | undefined) => void>();

const STORAGE_KEY = "gj_active_account_id";

function readStored(): number | undefined {
  if (typeof window === "undefined") return undefined;
  // Migrate the legacy session-only value so an in-progress session carries over.
  const legacy = window.sessionStorage.getItem(STORAGE_KEY);
  if (legacy) {
    window.sessionStorage.removeItem(STORAGE_KEY);
    window.localStorage.setItem(STORAGE_KEY, legacy);
  }
  const stored = Number(window.localStorage.getItem(STORAGE_KEY));
  return stored || undefined;
}

export function getSelectedAccountId() {
  if (selectedAccountId !== undefined) return selectedAccountId;
  return readStored();
}

export function setSelectedAccountId(accountId: number | undefined) {
  selectedAccountId = accountId;
  if (typeof window !== "undefined") {
    if (accountId) window.localStorage.setItem(STORAGE_KEY, String(accountId));
    else window.localStorage.removeItem(STORAGE_KEY);
  }
  listeners.forEach(listener => listener(accountId));
}

export function subscribeSelectedAccount(listener: (accountId: number | undefined) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
