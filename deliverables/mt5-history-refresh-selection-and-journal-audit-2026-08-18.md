# Gold Journal MT5, Refresh, Selection, and Journal Audit

**Date:** 18 August 2026  
**Repository:** `Najam27/gold-journal-`  
**Scope:** MT5 history synchronization, live refresh cadence, trade-form selection behavior, and active journal modules.

## Executive result

The reported failures were traced and repaired in the active source. The MT5 browser workspace already refreshed at 2.5 seconds, but the Expert Advisor defaulted to a 30-second whole-second timer. The EA now defaults to a 3-second timer, which is the practical minimum for the MQL5 timer API, while the browser continues refetching MT5 workspace and history every 2.5 seconds.

The MT5 history path previously persisted a full history batch concurrently. The database RPC locks the account row for atomic ownership and balance integrity, so concurrent writes for the same account could contend and cause a batch-wide `SYNC_UNAVAILABLE`. History positions are now persisted sequentially per batch. The server also classifies common schema and transient database errors as `MIGRATION_REQUIRED_0008` or `DATABASE_RETRYABLE` instead of hiding them behind a generic status. The MT5 history panel now distinguishes a query error from an EA batch failure and provides an explicit retry action.

The trade form’s actual state is click-driven, but CSS combined `:hover` with `.selected`, making chips appear selected as the pointer moved over them. Hover styling is now neutral across Trade Log, the month picker, and Plan & Execution archive search; only state-backed `.selected` elements receive selected styling. A regression test verifies that hovering or focusing a mistake chip does not call `setForm`, while clicking it does.

## Implemented changes

| Area | Repair |
|---|---|
| MT5 EA cadence | `SyncSeconds` default changed from 30 to 3; `EventSetTimer` enforces a 3-second minimum. Summary and open-position data therefore refresh approximately every 3 seconds. |
| MT5 history retry behavior | Added `g_last_history_attempt` so a failed full replay cannot resend the complete history on every timer event. Full-history retries are throttled to five minutes. |
| MT5 history persistence | Replaced concurrent `Promise.all` closed-position writes with sequential writes to avoid Supabase account-row lock/RPC contention. |
| MT5 error visibility | Added safe classification for migration-required and retryable database errors. No raw credentials or sensitive database values are exposed. |
| MT5 UI | History query refetches every 2.5 seconds, shows query failures separately from EA batch failures, and provides a `Retry history` action. |
| MT5 wording | UI now explains that browser refresh is 2.5 seconds and EA live updates are approximately 3 seconds. |
| Trade dialog | Removed hover-selected visual state from control-library and mistake chips. Added click-only regression coverage. |
| Other selection controls | Removed hover-selected appearance from the month picker and Plan & Execution archive search. Keyboard focus retains a visible focus outline. |
| Regression coverage | Added sequential-history ordering and migration-failure classification tests for MT5 ingest; updated MT5 Live and trade-dialog tests. |

## Active-module audit

The active journal modules were reviewed and their focused test suites passed: Trade Log and New Trade, Analysis and AI readiness, Goals, Plan & Execution, Options, MT5 Live, account switching, account scope, loading/auth state, mentor privacy, and journal statistics. Existing production components remain in use; unreachable showcase/simulated-demo code had already been removed in the prior hardening release.

The review confirmed that deterministic Analysis remains usable without AI configuration. AI Analysis and AI Mentor use server-only OpenRouter configuration and must not receive a browser-side API key. Goals and Plan & Execution use explicit click/change handlers and save/remove mutations with visible error states. Options uses account-scoped option-list procedures. The new CSS audit prevents hover from masquerading as committed selection in the related controls.

## Validation evidence

| Check | Result |
|---|---|
| TypeScript | Passed: `pnpm check` |
| Schema source audit | Passed: migrations 0001 through 0009 ordered and represented in Drizzle/migration sources |
| Full automated suite | Passed: 68 test files, 217 tests; 1 test file and 2 opt-in Supabase integration tests skipped |
| Production build | Passed: Vite frontend and bundled server build completed |
| Diff hygiene | Passed: `git diff --check` |
| Focused MT5/trade tests | Passed: 5 files, 32 tests |
| Focused active-module tests | Passed: 14 files, 33 tests |

The build still reports a non-fatal bundle-size warning for the existing large frontend chunks. It does not block deployment or correctness; further code-splitting can be a separate performance task.

## Required production actions

1. Wait for Netlify to deploy the new commit from `main`.
2. Apply Supabase migrations `0008_production_integrity_and_analysis.sql` and `0009_ai_report_history.sql` if they have not already been applied. The MT5 history RPC and the new analysis fields depend on migration 0008.
3. In Gold Journal, download **EA v2.1** again. Replace the old `.mq5`, compile it in MetaEditor, remove the old chart instance, and attach the newly compiled EA.
4. Keep the endpoint as `https://topgjournal.netlify.app/api/mt5`, use the current one-time API key, leave `ConnectionId` blank unless a real connection ID is explicitly supplied, and set the broker UTC offset correctly.
5. In MT5, add the endpoint to **Tools → Options → Expert Advisors → Allow WebRequest for listed URL**.
6. After attaching the EA, check MT5 Journal/Experts logs and Gold Journal MT5 Live. The connection should remain live, account metrics should refresh approximately every 3 seconds from the EA, the browser should refresh every 2.5 seconds, and history should progress from `RECEIVED`/`ACCEPTED` to `COMPLETED`; a BUY position closed by a SELL deal must remain BUY, and a SELL position closed by a BUY deal must remain SELL.
7. If the history panel reports `MIGRATION_REQUIRED_0008`, apply migration 0008 and redeploy/retry. If it reports `DATABASE_RETRYABLE`, wait briefly and use `Retry history`. If it reports `SYNC_UNAVAILABLE` after migration verification, inspect the Netlify function log for the corresponding server error and confirm the service-role Supabase environment variables.
8. Test New Trade by moving the pointer over level, confirmation, market-condition, and mistake chips without clicking; no value should change. Then click a chip and confirm only that clicked value is selected. Repeat for Plan & Execution and the month picker.

## Remaining limitation

The sandbox browser cannot authenticate into the user’s Supabase session, so final live account-specific smoke tests must be performed by the operator after deployment. The code, schema audit, focused tests, full tests, and production build are complete; the remaining production dependency is applying the database migrations and installing the rebuilt EA on the user’s terminal.


## Follow-up findings from the latest screenshots

The `MIGRATION_REQUIRED_0008` status was caused by a server-to-Supabase RPC contract mismatch, not necessarily by an unapplied migration. Migrations 0004 and 0008 define the JSON parameter as `position_payload`, while the server wrapper sent the parameter under the name `position`. PostgREST therefore could not resolve the function signature and the error classifier correctly surfaced the failure as migration-related. The wrapper now sends `position_payload`, and `server/atomicOperations.test.ts` verifies the exact argument contract.

The first level chips were rendered inside a `<label>` field wrapper while containing interactive `<button>` elements. That invalid nested-interactive structure can produce inconsistent click behavior in browser layouts. Trade dialog fields now use semantic `<div role="group">` wrappers with accessible labels, preserving normal input styling while giving level buttons direct click targets. Regression coverage now explicitly clicks both `SBR/TJL1` and `RBS/TJL1` in the Edit Trade path.

The follow-up release gate passed with **68 test files passed, 217 tests passed; 1 test file and 2 opt-in Supabase integration tests skipped**, plus TypeScript, schema audit, and production build success.


## Follow-up for `SYNC_UNAVAILABLE`

The remaining generic status was caused by the ingest layer discarding Supabase provider metadata from RPC errors. The atomic wrapper now preserves the provider code, details, and hint internally. The MT5 ingest layer classifies safe categories such as `PGRST202` schema/signature mismatch, `22P02` invalid data, `42501` permission/account rejection, lock/timeouts, and timestamp failures. The API returns a safe diagnostic message without exposing credentials or raw SQL. History status records now include the actionable category and diagnostic, so the next retry will distinguish a schema problem from invalid MT5 data or a temporary database lock.

The focused diagnostic release checks passed: **22 tests passed** across MT5 ingest, atomic Supabase wrappers, and the MT5 HTTP route, together with TypeScript validation.


## Whole-application follow-up findings

The deeper contract audit found three additional reliability defects. First, the `open_batch` discriminated-union validator incorrectly inherited single-position fields at the top level, so every valid EA batch containing only `positions` was rejected before persistence. The schema now validates the actual batch shape and the server writes the batch sequentially to avoid account-row lock contention.

Second, PostgREST metadata was preserved for atomic RPCs but was still discarded by ordinary Supabase query and write operations. The adapter now preserves provider code, details, and hint for all queries and writes, and unknown provider codes are included in the safe MT5 diagnostic.

Third, Trade Log loading was coupled to MT5 pre-synchronization. A broker/database sync failure could therefore hide otherwise valid manual journal trades. Trade Log now degrades gracefully, logs the MT5 pre-sync failure, and still loads the account’s journal rows.


## EA v2.1 historical reconstruction

The attached master prompt identified a correctness defect in the EA: historical direction was derived from the closing deal type. A BUY position normally closes with a SELL deal, so that implementation inverted the Trade Log direction. `GoldJournal_EA.mq5` now uses `HistorySelectByPosition(position_id)`, derives the original direction from the entry deal, handles reversal entries by taking the opposite of the reversal deal, and aggregates all deals for a position ID before emitting one idempotent historical record.

The EA now uses historical deal SL/TP values when available, includes commission, swap, and fee in realized P&L, calculates risk/reward only from actual recovered values, preserves zero/unknown semantics when values are unavailable, computes volume-weighted close price for multi-deal positions, bounds batches at 50 positions, and sends a successful empty `history_batch` when no closed positions exist. The source version is **2.1.0** and the dashboard guidance has been updated to EA v2.1.

A source-contract test verifies the reconstruction requirements. The repository does not contain MetaEditor or a Windows MT5 compiler, so final compilation must still be performed in MetaEditor on the operator’s MT5 terminal before attaching the EA.


## Read-only Netlify deployment verification

On 18 August 2026, the public site at `https://topgjournal.netlify.app/` loaded the unauthenticated Supabase-backed sign-in shell. The public download URL `https://topgjournal.netlify.app/GoldJournal_EA.mq5` was fetched successfully through the browser download path; the downloaded source reports `#property version "2.1"`, `SyncSeconds = 3`, and `ConnectionId = ""`, confirming that the v2.1 asset is present on the deployed site. This verifies the public deployment surface only. An authenticated account-specific MT5 smoke test and real MetaEditor compilation remain operator actions.
