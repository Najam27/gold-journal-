# Trade Log Persistence & Screenshot Durability Audit

**Repository:** [Najam27/gold-journal-](https://github.com/Najam27/gold-journal-)
**Date:** 2026-09-18
**Question answered:** "A trade appears in the UI immediately after creation, but after refresh / re-login / account change it can disappear, and a saved screenshot does not reliably come back."

**Conclusion:** the defect was **not** in `localStorage`. It was a chain of gaps across the write path, the queue, the API contract and the storage schema. Each gap is closed, and the claims below are asserted by tests that run the real router, the real PostgREST adapter and the real storage-path rules against an in-memory database and bucket.

---

## 1. The traced flow, and exactly where it stopped

```
Trade Dialog → form state → validation → submitTrade()
  → queueMutation() → journalStore (optimistic) → IndexedDB queue
    → flushJournalMutations() → dispatch() → tRPC trades.create/update/delete
      → goldRouter → drizzle/supabaseQuery → Postgres gj_trades
        → response → React Query invalidation → journal.get → Trade Log
          → refresh → re-read
```

| # | Stop point | Failure mode the user saw |
|---|---|---|
| 1 | `trades.create` response contract | Returned only `{ id, replayed }`. A locally saved trade kept its **negative placeholder id**, so the client never adopted the real database identity. |
| 2 | Queue replay of a stale target | An edit/delete issued before the create was confirmed addressed `id = -N`. The server rejected it forever, and because the drain is ordered, **every later queued write for that account was blocked behind it.** This is the "trade disappears after refresh" symptom: it existed locally, never reached Postgres. |
| 3 | `trades.delete` idempotency | Threw for an already-deleted row. A delete whose response was lost could never succeed on retry → same permanent queue block. |
| 4 | Screenshot upload as a **second request** | `uploadScreenshot(tradeId, …)` ran *after* the trade write and required a real server id. A new offline trade could not attach one at all, and a failed upload produced "Trade saved but screenshot upload failed. Re-upload from edit." → the image was lost. |
| 5 | Storage key vs. policy | Keys were `gold-journal/{openId}/trades/{id}-{nanoid}.{ext}`. The bucket policies authorize on the **first path segment**, so the constant `gold-journal` put every object outside the ownership rule; it only worked because the server holds the service role. No account segment existed, so there was no per-account isolation. |
| 6 | Trade Log read | One signed-URL call per row, unbounded. A slow storage call could push the list past the 15 s client timeout, which reads as "my trades vanished". |
| 7 | `screenshotName` stripped from the API payload | The browser could never label or restore a stored attachment, so the dialog had no way to show, replace or remove one. |
| 8 | A failure was unattributable | A production 500 was rewritten to a generic message with no reference, so a lost write could not be traced to a specific constraint or provider error. |
| 9 | Queue not account-scoped | Pending mutations were read per identity but **not per account**, so a previous account's queued write could be overlaid onto the newly selected account's view. |
| 10 | Account-wide deletes | `trades.clearAll` and `accounts.remove` deleted the rows but left the screenshot objects readable in the private bucket forever. |

## 2. The correct lifecycle (now implemented)

1. validate → 2. stable `clientMutationId` (the queue id doubles as the server idempotency key) → 3. optimistic local update → 4. persist to IndexedDB → 5. dispatch → 6. **server resolves the authenticated user and proves account ownership** → 7. INSERT/UPDATE/DELETE in Postgres → 8. return the **canonical row** → 9. remove the queue item **only after** the backend confirmed → 10. adopt the canonical identity (`reconcileCanonicalTrade`) → 11. `invalidateAccountScopedQueries` → 12. re-read the Trade Log.

If a write fails it stays queued with exponential backoff, the UI says so, and the local data is preserved. Nothing is silently marked synced.

## 3. Fixes

**Server (`server/`)**
- `goldRouter.trades.create/update/delete` return the canonical `toSafeTrade` row; a replayed `clientMutationId` returns the **same** row (`{ replayed: true }`) instead of a duplicate.
- `update`/`delete` accept `originMutationId`, so a queued change that still carries a negative placeholder id resolves to the row its create actually produced.
- A retried delete is idempotent: `{ success: true, deleted: false, replayed: true }` — a durable queue can never be poisoned by a lost response.
- New `trades.uploadScreenshotDraft`: the binary is uploaded to private storage **before** the row exists, and the returned stable object key travels **inside** the trade payload. Row + evidence are committed by one write.
- `screenshotRemoved` is the only signal that clears stored evidence; an ordinary field edit omits the columns entirely.
- `assertOwnedScreenshotPath` refuses any client-supplied key outside the caller's own identity **and** account.
- Enforced key shape: `{authUid}/accounts/{accountId}/trades/{tradeRef}/{file}` (`server/storage.ts`).
- `hydrateSignedScreenshots` bounds signing to concurrency 8 with a 1.5 s per-row time box, so one stalled object cannot hold the Trade Log open. Signed URLs are minted per read and never persisted.
- `storageRemoveMany` + `purgeAccountScreenshots`: `clearAll` and `accounts.remove` now remove the account's evidence before the rows that referenced it disappear.
- `withPersistenceDiagnostics` / `persistenceDiagnostics.ts`: one structured, redacted record per failure (identifiers, provider code/details/hint, duration — never tokens, notes or signed URLs), and the correlation id is lifted into `data.correlationId` by the tRPC error formatter.

**Client (`client/src/`)**
- `journalSync.flushJournalMutations` removes a queue item only after `dispatch` resolves, reports `confirmed` canonical records, and discards an item that can *never* apply (`JournalMutationDiscarded`) instead of blocking the queue behind it.
- `foldTradeEditIntoPendingCreate` merges an edit of a not-yet-synced trade into its queued create, so exactly **one** backend trade is created with the user's final values; a delete cancels it outright.
- `useLocalJournal` renders `{newest server payload} ⊕ {queued edits}`, keeps a confirmed record visible until the refetch lands, scopes the queue per account, and exposes `pendingTrades` / `pendingDeletedIds`.
- `GoldJournal.tsx` routes create/update/**delete** through the durable queue, prefers the reconciled payload, labels unacknowledged rows `PENDING SYNC`, and hides a row it has queued a delete for.
- `TradeDialogWithCustomOptions.tsx` distinguishes "nothing stored", "stored and untouched", "replace" and "remove", and uploads the image before saving.

**Database (`supabase/migrations/0025_trade_evidence_durability.sql`)** — additive, re-runnable
- re-asserts `clientMutationId` + `screenshotKey` + `screenshotName` and the unique `(userId, accountId, clientMutationId)` index (safe retries, no duplicates);
- rejects an absolute URL / traversal / oversized `screenshotKey` (`gj_trades_screenshot_key_shape`), and keeps key+name paired;
- makes the `trade-screenshots` bucket private and scopes its policies to **`{uid}/accounts/{accountId}/…`** via `owns_screenshot_account_folder`;
- adds the composite `(accountId, userId)` owner FK `gj_trades_account_owner_fk`.

**Tooling:** `scripts/schema-source-audit.mjs` was failing on migration drift (it stopped at `0022`). It now covers `0023`–`0025` and asserts the offline-replay + screenshot-durability objects in both the Drizzle schema and the migration. `pnpm schema:audit` passes.

## 4. Evidence

- `server/tradePersistence.test.ts` — real router + real `supabaseQuery` + real storage rules over an in-memory Postgres/bucket: create is an INSERT into `gj_trades`; the trade is still found after a "reload"; a replayed `clientMutationId` resolves to the same row; a negative placeholder id is resolved through `originMutationId`; a retried delete is idempotent; a screenshot key+name persist in the same write and come back as a fresh signed URL after reload; a foreign account's key is refused; accounts are mutually invisible; `clearAll` and `accounts.remove` delete only their own objects.
- `client/src/lib/journal/journalPersistence.test.ts` — the durable queue: offline create survives a reload and is never claimed synced; exactly one delivery on reconnect and on retry; a poisoned item is discarded without blocking later writes; per-identity and per-account isolation; canonical reconciliation; `useLocalJournal` shows a just-saved trade as pending and keeps it after confirmation, reports failure instead of success, and restores unsynced work on an offline cold start.
- `server/storage.test.ts`, `client/src/pages/GoldJournal.accountScope.test.ts` — key ownership/traversal/absolute-URL rejection and the account-scope contract in the page.
- `pnpm check` (tsc) clean; full `pnpm test` suite green.

## 5. Required operational step

**Apply `supabase/migrations/0025_trade_evidence_durability.sql`** (after `0024`) in the Supabase SQL Editor, then redeploy. The code is written to be safe before it lands (draft uploads and the existing `0013` columns keep working), but **without 0025 the account-scoped storage policies, the screenshot key shape constraint and the re-asserted replay index are not in force.** README deployment notes now cover `0001`–`0025`.

## 6. Known limits (not user-visible regressions)

- Legacy objects written under the old `gold-journal/{openId}/trades/…` prefix are not migrated; they are unreachable from the new key scheme. Screenshots attached before this change should be re-attached from the edit dialog. A one-off backfill script can be added on request.
- Draft objects whose trade was never saved (upload succeeded, browser closed before save) are not listed by any row, so the account-wide purge cannot see them. A prefix-based bucket sweep would be needed to reclaim those.
- `purgeAccountScreenshots` is best-effort by design: an orphaned object is a leak, a failed destructive operation is a returned error, so cleanup never fails the clear or the removal.
