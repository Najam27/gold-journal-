type Invalidate = () => Promise<unknown>;

export type AccountScopedUtils = {
  journal: { get: { invalidate: Invalidate } };
  trades: { list: { invalidate: Invalidate } };
  mt5: { workspace: { invalidate: Invalidate }; history: { invalidate: Invalidate } };
  notifications: { get: { invalidate: Invalidate } };
  optionLists?: { list: { invalidate: Invalidate } };
};

export function invalidateAccountScopedQueries(utils: AccountScopedUtils) {
  const invalidations = [
    utils.journal.get.invalidate(),
    utils.trades.list.invalidate(),
    utils.mt5.workspace.invalidate(),
    utils.mt5.history.invalidate(),
    utils.notifications.get.invalidate(),
  ];
  if (utils.optionLists) invalidations.push(utils.optionLists.list.invalidate());
  return Promise.all(invalidations);
}
