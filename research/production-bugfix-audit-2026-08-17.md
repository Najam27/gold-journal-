# Gold Journal Production Bug-Fix Audit — 17 August 2026

## Scope

This audit follows the uploaded production bug-fix brief without rebuilding the application or changing its architecture. It covers multi-account MT5 ownership, account switching and cached data, active interaction wiring, theme-sensitive presentation, and responsive constraints. Fixed PKT / UTC+5 MT5 behavior is outside the repair scope and must remain unchanged.

## Verified MT5 Ownership Flow

The current schema and server path already enforce the required ownership chain.

| Boundary | Verified behavior |
|---|---|
| Trading account → MT5 connection | `gj_mt5_connections` stores `accountId` and `userId`; its existing unique index permits one MT5 connection per trading account. |
| Trading account → MT5 live position | `gj_mt5_live_positions` stores `accountId` and uses unique `(accountId, ticket)`. |
| Trading account → journal trade | `gj_trades` stores `userId`, `accountId`, and uses unique `(accountId, mt5Ticket)`. Identical tickets across different accounts remain independent. |
| Protected read | `getMt5Workspace()` and `getMt5History()` call `getOwnedAccount(userId, accountId)` and query only the given `accountId`. |
| Protected MT5 mutation | Connection update, activation, and deletion check `userId + accountId + connectionId` through `ownMt5Connection()`. |
| Public EA ingest | `/api/mt5` authenticates an API key to exactly one active connection, derives `connection.userId` and `connection.accountId`, and passes those values to all open, close, summary, and history writes. Payload account IDs are not accepted by the event schema and cannot override the authenticated connection. |
| MT5-to-journal sync | Open and closed position upserts and journal writes use the account derived from the authenticated connection, inside their existing lifecycle transactions. |

The data model deliberately allows **one MT5 connection per trading account**, not several. This follows the existing `gj_mt5_connection_account_unique` constraint and is not changed by this task. The active MT5 Live connection list therefore reads only the selected account’s scoped workspace; it is not a user-global connection manager.

## Verified Issue and Minimal Repair

The main Gold Journal account switcher changes `accountId`, and its query inputs already include that identity. However, the direct switch path relied on later query-key changes and a partial `refresh()` helper that does not invalidate MT5 history, notifications, or option lists. The smallest compatible improvement is to use the existing shared `invalidateAccountScopedQueries()` helper immediately on an account switch, while also updating both local and shared selected-account state. This eliminates avoidable stale-cache windows without using frontend filtering as an isolation mechanism.

## Interaction and UI Audit Outcome

The static audit found 189 `onClick` and 146 `onChange` occurrences in the frontend. No empty event handlers, `Coming Soon`, `Not implemented`, TODO/FIXME interaction stubs, or alert-only product handlers were found in active Gold Journal code. The only `console.log` is a non-routed `ComponentShowcase` demo submission, which will be removed as a hygiene cleanup. Active MT5 controls invoke their intended tRPC mutations or query refetches, include asynchronous feedback, and do not display raw API keys after their one-time creation dialog.

The current semantic UI system has both light and dark trading-state tokens. Remaining direct color occurrences are either legacy selectors already neutralized by the final semantic layer, generic shadcn primitives, chart-library requirements, or the non-routed demo dialog. They will not be blindly rewritten. Dense tables intentionally retain local horizontal scrolling; responsive dialog maxima, safe-area navigation, and touch targets remain intentional constraints.

## Regression Matrix

The implementation will preserve and extend coverage for: account A / B independent workspace reads, identical tickets across accounts, API-key-derived account ownership, spoofed payload account IDs, account-owned connection mutations, A → B client account switch invalidation, and no-op handler absence in active product controls. Existing UTC+5 timestamp regressions will run unchanged as a guardrail.

## Completed Repair and Validation

`client/src/pages/GoldJournal.tsx` now routes sidebar, options-page, and newly-created-account changes through one `switchAccount()` callback. The callback updates the selected account, resets pagination, and invokes the shared `invalidateAccountScopedQueries()` helper. The same complete helper now powers general journal refreshes, covering `journal.get`, paginated trade lists, MT5 workspace, MT5 history, notifications, and option lists rather than only a subset of those account-scoped resources. The server remains the isolation boundary: this client invalidation prevents stale rendering, but does not filter or authorize MT5 records.

`client/src/pages/GoldJournal.accountScope.test.ts` verifies that the live account switch and refresh paths remain wired to the full invalidation helper. The existing account-scope test confirms the helper covers all six relevant query groups. The existing MT5 ingest, lifecycle, and protected-router tests already cover API-key-derived account ownership, spoofed input isolation, composite ticket identity, account-owned connection mutation rejection, transactional lifecycle behavior, and account-scoped sync.

Full validation succeeded after the change: **41 test files / 126 tests**, TypeScript `--noEmit`, production build, and service-worker syntax check. The static interaction audit found no active empty, placeholder, TODO, Coming Soon, or alert-only product actions. The only `console.log` was confined to the non-routed component showcase demo and does not participate in Gold Journal’s production routes. No schema migration or database change was necessary because the existing composite account/ticket identities already satisfy the multi-account requirements. The PWA cache generation advances from `v11` to `v12` for returning and installed clients.

## Explicit Invariants

> **MT5 UTC+5 behavior was preserved and not changed.** The normalizer, `Asia/Karachi` session classification, broker-offset fallback, and existing MT5 EA contract are untouched.

> **MT5 connection → trading account → trade ownership is enforced** by API-key resolution to one active connection, connection-owned `userId` and `accountId` derivation, account-scoped live-position and journal writes, composite `(accountId, ticket)` identity, and protected `userId + accountId + connectionId` operations.
