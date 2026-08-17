type RecordWithInternalScope = Record<string, unknown>;

function withoutInternalScope<T extends RecordWithInternalScope>(record: T, extraInternalFields: string[] = []): T {
  const copy = { ...record } as Record<string, unknown>;
  ["userId", "accountId", "createdAt", "updatedAt", ...extraInternalFields].forEach(field => delete copy[field]);
  return copy as T;
}

export function toSafeTrade<T extends RecordWithInternalScope>(trade: T): T & { hasScreenshot: boolean } {
  const copy = withoutInternalScope(trade, ["screenshotKey", "screenshotName", "mt5Ticket"]);
  return { ...copy, hasScreenshot: Boolean(trade.screenshotKey) };
}

export function toSafeJournalRecord<T extends RecordWithInternalScope>(record: T): T {
  return withoutInternalScope(record);
}

export function toSafeAccount<T extends RecordWithInternalScope>(account: T): T {
  return withoutInternalScope(account, ["createdAt", "updatedAt"]);
}
