import { queryClient } from "./queryClient";

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

/**
 * Rejects a server payload that belongs to a different account than the one the
 * user has selected. This is the single guard that prevents "old account data ->
 * new account UI": placeholder data (and any late response) still carries the
 * previous account's `activeAccount.id`.
 */
export function payloadBelongsToAccount(payload: unknown, accountId: number | undefined): boolean {
  if (accountId == null) return true;
  const active = (payload as { activeAccount?: { id?: unknown } } | null | undefined)?.activeAccount;
  if (!active || active.id == null) return true;
  return Number(active.id) === Number(accountId);
}

/**
 * Every query that is scoped by an account id in its input. Invalidation of
 * these is what used to build an eight-request storm on every account switch.
 */
const ACCOUNT_SCOPED_PATHS: Record<string, true> = {
  "journal.get": true,
  "trades.list": true,
  "mt5.workspace": true,
  "mt5.history": true,
  "mt5.integrity": true,
  "mt5.risk": true,
  "analysis.get": true,
  "analysis.history": true,
  "analysis.experiments": true,
  "analysis.compare": true,
};

export type QueryKeyLike = readonly unknown[];

export function accountScopedQueryPath(key: QueryKeyLike | undefined): string | null {
  const path = key?.[0];
  if (!Array.isArray(path) || !path.length) return null;
  const joined = path.join(".");
  return ACCOUNT_SCOPED_PATHS[joined] ? joined : null;
}

/** Reads the account id out of a tRPC query input, including nested inputs. */
export function queryInputAccountId(input: unknown): number | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const direct = Number(record.accountId);
  if (Number.isInteger(direct) && direct > 0) return direct;
  return queryInputAccountId(record.current) ?? queryInputAccountId(record.previous);
}

export function isAccountScopedQueryKey(key: QueryKeyLike | undefined): boolean {
  return accountScopedQueryPath(key) !== null;
}

export function queryKeyAccountId(key: QueryKeyLike | undefined): number | undefined {
  if (!isAccountScopedQueryKey(key)) return undefined;
  const meta = key?.[1] as { input?: unknown } | undefined;
  return queryInputAccountId(meta?.input);
}

/** Structural view of the TanStack query client, so the switch is unit testable. */
export type AccountSwitchClient = {
  cancelQueries: (filters?: { predicate?: (query: { queryKey: QueryKeyLike }) => boolean }) => Promise<void>;
  removeQueries: (filters?: { predicate?: (query: { queryKey: QueryKeyLike }) => boolean }) => void;
};

export type AccountSwitchResult = { canceled: number; removed: number };

/**
 * The account-switch transaction.
 *
 * Ordering matters and is deliberately explicit:
 *   1. cancel every in-flight account-scoped request, so a response for the
 *      previous account can never be committed after the switch;
 *   2. remove the previous account's cached payloads (including cache entries
 *      with no account id), so stale data cannot be rendered as the new account;
 *   3. the caller then publishes the selection; React mounts the new account's
 *      queries itself, fetching the critical Trade Log read first.
 *
 * Nothing is invalidated here: invalidation refetches active queries for the
 * OLD key set, which is exactly the storm this replaces.
 */
export async function beginAccountSwitch(client: AccountSwitchClient, nextAccountId: number | undefined): Promise<AccountSwitchResult> {
  if (!nextAccountId) return { canceled: 0, removed: 0 };
  const target = Number(nextAccountId);
  let canceled = 0;
  await client.cancelQueries({
    predicate: query => {
      if (!isAccountScopedQueryKey(query.queryKey)) return false;
      canceled += 1;
      return true;
    },
  });
  let removed = 0;
  client.removeQueries({
    predicate: query => {
      if (!isAccountScopedQueryKey(query.queryKey)) return false;
      const id = queryKeyAccountId(query.queryKey);
      if (id != null && Number(id) === target) return false;
      removed += 1;
      return true;
    },
  });
  return { canceled, removed };
}

/** Convenience wrapper over the app-wide query client used by the dashboard. */
export function beginAccountSwitchForApp(nextAccountId: number | undefined) {
  return beginAccountSwitch(queryClient as unknown as AccountSwitchClient, nextAccountId);
}

/**
 * Account-scoped writes that ran (or a manual refresh) still invalidate
 * normally. This is deliberately NOT used by the account switch.
 */
export function refreshCurrentAccount(utils: AccountScopedUtils) {
  return invalidateAccountScopedQueries(utils);
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
