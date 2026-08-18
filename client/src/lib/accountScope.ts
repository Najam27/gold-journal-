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
