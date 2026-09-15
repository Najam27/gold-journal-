type Invalidate = () => Promise<unknown>;

export type AccountScopedUtils = {
  journal: { get: { invalidate: Invalidate } };
  accounts?: { list: { invalidate: Invalidate } };
  trades: { list: { invalidate: Invalidate } };
  mt5: { workspace: { invalidate: Invalidate }; history: { invalidate: Invalidate } };
  notifications?: { get?: { invalidate?: Invalidate } };
  analysis?: { get: { invalidate: Invalidate } };
  optionLists?: { list: { invalidate: Invalidate } };
};

function safeInvalidate(target: { invalidate?: Invalidate } | undefined) {
  try { return Promise.resolve(target?.invalidate?.()).catch(() => undefined); } catch { return Promise.resolve(); }
}

/**
 * Picks the trading account the UI must act on.
 *
 * The selected account always wins. A server payload is only trusted when its
 * own id already matches the selection, because journal queries keep the
 * previous account's data alive while the next one loads. Both sides can be
 * unknown at the same time (a cold start before the first account is selected),
 * so a missing selection must never be compared as if it were an id.
 */
export function resolveActiveAccount<T extends { id: number }>(
  serverAccount: T | null | undefined,
  accounts: readonly T[] | null | undefined,
  accountId: number | undefined
): T | undefined {
  if (serverAccount && accountId != null && serverAccount.id === accountId) return serverAccount;
  const owned = (accounts ?? []).find(item => item?.id === accountId);
  return owned ?? serverAccount ?? undefined;
}

export function invalidateAccountScopedQueries(utils: AccountScopedUtils) {
  const invalidations = [
    safeInvalidate(utils.journal?.get),
    safeInvalidate(utils.trades?.list),
    safeInvalidate(utils.mt5?.workspace),
    safeInvalidate(utils.mt5?.history),
    safeInvalidate(utils.notifications?.get),
  ];
  if (utils.accounts) invalidations.push(safeInvalidate(utils.accounts.list));
  if (utils.analysis) invalidations.push(safeInvalidate(utils.analysis.get));
  if (utils.optionLists) invalidations.push(safeInvalidate(utils.optionLists.list));
  return Promise.all(invalidations);
}
