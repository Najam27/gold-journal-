type RecordWithInternalScope = Record<string, unknown>;

function withoutInternalScope<T extends RecordWithInternalScope>(record: T, extraInternalFields: string[] = []): T {
  const copy = { ...record } as Record<string, unknown>;
  ["userId", "accountId", "createdAt", "updatedAt", ...extraInternalFields].forEach(field => delete copy[field]);
  return copy as T;
}

export function toSafeTrade<T extends RecordWithInternalScope>(trade: T): T & { hasScreenshot: boolean } {
  // The storage KEY stays server-side: it is an internal private path, and the
  // browser is handed a freshly signed, short-lived URL instead (minted per read
  // by trades.list). The original filename is not sensitive and is needed to
  // label the attachment in the UI, so it travels with the trade.
  const copy = withoutInternalScope(trade, ["screenshotKey", "mt5Ticket"]);
  return { ...copy, hasScreenshot: Boolean(trade.screenshotKey) };
}

export function toSafeJournalRecord<T extends RecordWithInternalScope>(record: T): T {
  return withoutInternalScope(record);
}

export function toSafeAccount<T extends RecordWithInternalScope>(account: T): T {
  return withoutInternalScope(account, ["createdAt", "updatedAt"]);
}

export function toSafeAccountListItem<T extends RecordWithInternalScope>(account: T) {
  return { id: account.id, name: account.name, startingBalance: account.startingBalance, createdAt: account.createdAt, updatedAt: account.updatedAt };
}
