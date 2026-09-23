# Gold Journal — Direct Trade Persistence (no local-first trade store)

**Repository:** [Najam27/gold-journal-](https://github.com/Najam27/gold-journal-)
**Date:** 2026-09-23
**Previous commit:** `04cb44b` — `fix(trade-log): rebuild the PDF report layout so nothing can overlap`
**Scope:** journal trade persistence only. MT5, analysis, psychology, goals, plan, AI mentor,
risk calculator, exports, account switching, theming and the screenshot viewer are untouched.

---

## 1. Why trades were accumulating locally

The journal was **local-first**. `GoldJournal.tsx` never called `trades.create/update/delete`
directly. Every trade action was handed to a durable browser queue:

```text
Save Trade → applyMutationToJournal (optimistic trade with a NEGATIVE id)
           → writeJournalRecord(IndexedDB "journal-queue")
           → UI shows the trade immediately, badged "pending sync"
           → background flush (on start, on a 20 s timer, on reconnect) calls tRPC
           → a failed flush only records a backoff and keeps the item queued
```

Three properties of that design produced the reported behaviour:

1. **The successful path never required the cloud.** `queueMutation()` resolved as soon as the
   IndexedDB write succeeded, so the dialog closed with *"Trade saved and syncing now"* even
   when nothing had reached Supabase. The trade was already a permanent-looking Trade Log row.
2. **Failures were invisible.** A rejected or failing flush stayed in the queue with an
   exponential backoff (up to 60 s, up to 200 items, 14 days). Multiple trades therefore
   accumulated in the browser while cloud persistence silently failed.
3. **The Trade Log merged local state into the server read.** `pagedTrades` was
   `[...pendingRowsForView, ...serverPageTrades]`, and `data` was
   `reconciledPayload ?? journalPayload ?? localSnapshot`, so queued and *snapshot-only* trades
   rendered as Trade Log rows — including after a reload, from IndexedDB.

## 2. Files that implemented the local-first flow

| File | Role |
|---|---|
| `client/src/lib/journal/journalStore.ts` | IndexedDB snapshot + queue store, `applyMutationToJournal`, `reconcileCanonicalTrade` |
| `client/src/lib/journal/journalSync.ts` | `enqueueJournalMutation`, `flushJournalMutations`, backoff, FIFO queue, `clientMutationId` generation |
| `client/src/lib/journal/useLocalJournal.ts` | The runtime hook: snapshot hydration, queue overlay, auto-flush, optimistic `pendingTrades` / `pendingDeletedIds` |
| `client/src/lib/journal/journalSync.test.ts`, `journalPersistence.test.ts` | Tests of the queue and optimistic-store behaviour |
| `client/src/lib/offlineMutationQueue.ts` | Legacy offline cash event channel |
| `client/src/pages/GoldJournal.tsx` | The wiring: `useLocalJournal({ dispatch })`, `queueMutation` for create/update/delete/cash, `JournalSyncIndicator`, local payload merge, pending-row merge |
| `client/src/pages/GoldJournal.accountScope.test.ts` | Asserted the local-first contract (reconciled payload, pending merge, queued writes) |

## 3. Files changed

**Removed (no local trade persistence exists any more):**

- `client/src/lib/journal/journalStore.ts`
- `client/src/lib/journal/journalSync.ts`
- `client/src/lib/journal/useLocalJournal.ts`
- `client/src/lib/journal/journalSync.test.ts`
- `client/src/lib/journal/journalPersistence.test.ts`
- `client/src/lib/offlineMutationQueue.ts`

**Added:**

- `client/src/lib/journal/legacyLocalJournalCleanup.ts` — one-time deletion of the legacy
  `gold-journal` IndexedDB database (cleanup only; it never reads or uploads local trades).
- `client/src/lib/tradePersistenceArchitecture.test.ts` — architecture contract test: the
  local-first modules must stay deleted, and there must be exactly one save path.

**Modified:**

- `client/src/pages/GoldJournal.tsx` — direct persistence, save-state machine, server-only Trade Log.
- `client/src/components/TradeDialogWithCustomOptions.tsx` — `Saving… / Saved / Save failed` UI.
- `client/src/lib/apiErrors.ts` — network-failure guidance no longer promises a local queue.
- `server/goldRouter.ts` — added `trades.discardScreenshotDraft` (orphan cleanup).
- `server/tradePersistence.test.ts`, `client/src/pages/GoldJournal.accountScope.test.ts` — updated
  to the new contract and extended.

## 4. How direct Supabase persistence now works

`GoldJournal.tsx` now holds the three trade mutations and calls them itself:

```text
TradeDialog  →  submitTrade()                       (validate input)
             →  trades.uploadScreenshotDraft  (only if an image was chosen)
             →  trades.create   |   trades.update   (direct tRPC mutation)
             →  server: authenticated user → owned account → INSERT/UPDATE in gj_trades
             →  server returns the canonical row (+ replay flag)
             →  refreshCurrentAccount(utils)  →  trades.list + journal.get + analysis + MT5 refetch
             →  dialog shows "Saved", then closes
```

- **Create:** `await createTrade.mutateAsync({ ...payload, clientMutationId: attemptId, ...evidence })`
- **Update:** `await updateTrade.mutateAsync({ ...payload, tradeId: editingId, clientMutationId: attemptId, ...evidence })`
- **Delete:** `await deleteTrade.mutateAsync({ tradeId })` → backend deletes the row, removes the
  stored screenshot, and the Trade Log refetches.

Delete no longer has a `tradeId < 0` / `originMutationId` fallback path, because a trade that is
being edited or deleted always comes from the server now. The **server** keeps its
negative-placeholder resolution and the unique `(userId, accountId, clientMutationId)` index: the
frontend no longer needs offline replay, but server-side idempotency is still required so a
retried save (or a double submit) can never insert two trades.

**Trade Log source of truth** — `pagedTrades = tradeListQuery.data?.trades ?? []`, i.e.
`trades.list` alone. No pending overlay, no snapshot fallback, no account-agnostic merge:

```text
page load / refresh / account switch / reopening Trade Log
        ↓
trades.list (server, paginated, ownership-checked)
```

The dashboard payload (`data`) is now `payloadBelongsToAccount(journalQuery.data, accountId)` and
nothing else — a trade that is not in `gj_trades` cannot appear anywhere in the UI.

**Loading states (requirement 15):** `saveStatus` is `idle → saving → saved | error`.

- the Save/Cancel buttons are disabled for the whole attempt, including the screenshot upload;
- `saveInFlightRef` guards `submitTrade()` itself, so a double click cannot start a second request;
- on failure the dialog stays open, shows `Save failed — <server message>`, and re-enables Save;
- on success it shows `Saved` for 700 ms, then closes and the refetched list is already in place.

## 5. How screenshots are persisted

```text
user picks image
   ↓  readFileAsDataUrl
trades.uploadScreenshotDraft({ accountId, clientMutationId: attemptId, fileName, mimeType, base64 })
   ↓  server: account ownership proven → magic-byte + 5 MB validation
   ↓  storagePutAt(`${authUid}/accounts/${accountId}/trades/draft-${attemptId}/<uuid>.<ext>`)
stable screenshotKey returned
   ↓  screenshotKey + screenshotName travel INSIDE the trade payload
trades.create / trades.update
   ↓  row and evidence committed by one database write
read: trades.list mints a short-lived signed URL per row (`hydrateSignedScreenshots`)
```

The image is never held only in React state, an object URL, base64, localStorage or IndexedDB;
the row stores the stable object key (never a signed URL), and a signed URL is minted per read.

**Failure handling (requirement 9):**

- upload fails → `Screenshot upload failed. <reason>`; the dialog stays open with the user's data
  and the selected file, so tapping Save again retries. No trade is written.
- upload succeeds but the trade write fails → `Save failed — <reason>`, and the orphan draft object
  is removed through the new `trades.discardScreenshotDraft` mutation (best effort).

**Edit semantics (requirement 10):**

- no new image → the payload carries no screenshot fields, and the server's update omits the
  `screenshotKey`/`screenshotName` columns entirely (an ordinary field edit cannot drop evidence);
- new image → uploaded first, key replaces the old one inside the update, and the superseded object
  is removed after the row is stored;
- explicit remove → `screenshotRemoved: true` → the row is set to `null` and the old object is
  removed.

## 6. Database migration required?

**No.** The existing schema already supports this design:
`gj_trades.clientMutationId` with the unique partial index
`gj_trades_owner_account_client_mutation_unique` (migration `0013`), `screenshotKey` /
`screenshotName`, and the owner composite FKs from `0005`. No new column, table or RPC was added,
so **no migration needs to be applied** for this change.

## 7. Supabase Storage change required?

**No.** The private bucket and its policies are unchanged. Only one new server procedure was added
(`trades.discardScreenshotDraft`), which reuses the existing ownership helper
(`assertOwnedScreenshotPath`), and is additionally restricted to **unclaimed draft folders**
(`…/trades/draft-*/…`) so it can never strip the evidence off a stored trade row.

## 8. How old local trades are handled

Nothing is uploaded. The database is the authority and every trade it accepted is already there;
re-uploading an IndexedDB snapshot would create duplicates.

On mount, `GoldJournal` calls `purgeLegacyLocalJournalStore()` once, which deletes the legacy
`gold-journal` IndexedDB database (snapshots and queue) if the device still has one. The cleanup:

- touches only that database — never AI settings, UI preferences, the theme or the sidebar rail;
- never calls the API and never inserts anything;
- is best-effort and cannot block the app.

A local-only record that the database never accepted therefore disappears on the next read instead
of silently remaining a permanent Trade Log row. This is the controlled cleanup path the brief asked
for; no automatic migration is performed because a heuristic upload is exactly how duplicates would
be created.

## 9. Tests executed

```bash
pnpm exec tsc --noEmit          # clean
pnpm exec vitest run            # 111 files passed | 1 skipped, 859 tests passed | 2 skipped
```

New/updated coverage:

- `client/src/lib/tradePersistenceArchitecture.test.ts`
  - the four local-first modules must not exist;
  - exactly one save path: `trades.create/update/delete` called directly + `trades.list` read;
  - **no** `enqueueJournalMutation` / `flushJournalMutations` / `readJournalSnapshot` /
    `applyMutationToJournal` / `useLocalJournal` / `journalSync` / `journalStore` /
    `offlineMutationQueue` / `localPending: true` anywhere in `client`, `server`, `shared`, `worker`;
  - `GoldJournal.tsx` contains no `indexedDB` reference and no journal/trade `localStorage` usage,
    while the legitimate local storage (AI settings, sidebar width) still exists;
  - the cleanup module contains no API call;
  - the backend still proves account ownership on create/update/delete and still honours
    `clientMutationId`.
- `client/src/pages/GoldJournal.accountScope.test.ts`
  - the page renders the server payload only (no reconciled payload, no local snapshot);
  - save/update/delete call the backend directly and refetch via `refreshCurrentAccount`;
  - the `Saving… / Saved / Save failed` machine, the in-flight guard, and the orphan cleanup exist;
  - the Trade Log is populated only from `trades.list`;
  - the legacy store is purged without re-uploading.
- `server/tradePersistence.test.ts` (new cases)
  - an orphan draft screenshot is discarded after a failed trade write;
  - `discardScreenshotDraft` refuses a **claimed** trade path and another account's key, leaving the
    object untouched — so the draft cleanup path cannot delete real evidence.

## 10. Refresh / logout / login verification

Verified against the fake-Supabase integration suite (real router, real query adapter, real
ownership helpers, real storage rules) and by static contract tests:

| Step | Evidence |
|---|---|
| Save | `trades.create` executes an INSERT into `gj_trades` and returns the canonical row (`server/tradePersistence.test.ts`) |
| Confirm the trade appears | `trades.list` returns it; the page renders `tradeListQuery.data.trades` only |
| Refresh | `"still finds the trade after a reload re-reads the trade log from the backend"` — a fresh caller with no in-memory state sees the row |
| Logout / login again | The trade is only addressable through the authenticated, account-scoped read; the page keeps no local copy to restore from, and the cache is cleared on identity change (`queryClient` / `accountScope` behaviour, unchanged) |
| Multiple trades | Five sequential `trades.create` calls each return their own canonical row; the paginated list reports all of them (no local accumulation is possible — the queue no longer exists) |
| Failure | A rejected write leaves `gj_trades` empty, the dialog shows `Save failed`, and a later `trades.list` does not contain it |

A browser-level A→logout→B matrix against the live Supabase project remains an operational gate for
the deployment owner (no live project credentials are available in this workspace).

## 11. Screenshot persistence verification

- `uploadScreenshotDraft` places real bytes in the (fake) object bucket and returns a relative key
  scoped to `journal-owner/accounts/12/trades/draft-<attemptId>/…`;
- `trades.create` stores that key and filename in the same write as the trade;
- `trades.list` returns `hasScreenshot: true`, the original filename, and a freshly signed URL —
  and never leaks the raw storage key;
- removing a screenshot clears both columns **and** deletes the superseded object;
- deleting a trade deletes its object; clearing an account deletes that account's objects only;
- a failed write's draft object is discarded, and the discard path refuses non-draft keys and other
  accounts.

## 12. Remaining issues / notes

1. **Offline saving is gone by design.** With direct persistence there is no offline queue: while
   offline a save fails with a clear message and must be retried. This is the requested trade-off —
   the brief requires that no trade is ever a permanent local record before Supabase confirms it.
   Cash movements follow the same direct path (`cash.create`); the old offline cash event channel was
   removed with the queue.
2. **Server-side legacy tolerance kept.** `trades.update/delete` still accept a negative id with
   `originMutationId` and the `clientMutationId` column/index remain in the schema. They are no
   longer reachable from the app (the architecture test asserts the frontend never uses them), but
   removing the database constraint was explicitly out of scope, so it was left in place.
3. **Retry semantics.** A save that fails at the transport layer after the server committed is
   resolved by the per-attempt idempotency key only within the same attempt; a manual retry creates
   a new attempt id. The Trade Log read (invalidate + refetch) is the reconciliation step.
4. **Dead renderer affordances.** `TradeLogWithViewer` / `DayTradesDialog` still understand a
   `localPending` flag and would render a "pending sync" badge; no code path sets it any more. Left
   in place deliberately (pure renderer guards, covered by their own tests).
5. **UI-level verification.** The full React suite, TypeScript check and the server integration suite
   pass here. A live browser pass (add five trades, refresh, switch account) against the deployed
   Supabase project is still recommended before calling the release verified in production.

## Acceptance criterion

> Click Save → Supabase successfully stores the trade → the UI receives the canonical server record
> → refresh fetches the trade from Supabase.

Met: there is no local-first trade database, no pending local trade accumulation, no silent
cloud-sync dependency, and no screenshot that exists only in the browser.
