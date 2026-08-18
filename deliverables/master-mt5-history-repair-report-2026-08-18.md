# Gold Journal MT5 Historical Synchronization — Master Repair Report

**Date:** 18 August 2026  
**Repository:** [Najam27/gold-journal-](https://github.com/Najam27/gold-journal-)  
**Release commit:** [`784a812`](https://github.com/Najam27/gold-journal-/commit/784a81272b97a617355ce6a2306568d5d610aff6)  
**Scope:** Production-grade, idempotent, tenant-safe synchronization of closed MT5 positions into exactly one Gold Journal Trade Log entry per MT5 ticket.

> **Release conclusion.** The repository-side repair is complete and pushed to `origin/main`. The MT5 path now remains server-mediated from EA to Netlify to Supabase RPC to the Trade Log. Automated checks pass, the public Netlify site serves the EA v2.1 asset, and the remaining production steps are applying/verifying Supabase migrations and compiling/attaching the EA in MetaEditor. An authenticated end-to-end MT5 smoke test was not claimed because it requires the operator’s live Supabase and MT5 sessions.

## Executive status

| Area | Result | Evidence |
|---|---|---|
| Repository repair | Complete and pushed | Commit `784a812` and preceding repair commits |
| TypeScript | Passed | `pnpm check` |
| Full tests | Passed | 68 test files passed; 1 opt-in integration file skipped; 217 tests passed; 2 opt-in Supabase integration tests skipped |
| Production build | Passed | Vite client and bundled server build completed |
| EA contract | Rebuilt as v2.1 | Position-level aggregation, original-direction reconstruction, SL/TP recovery, fee-inclusive P&L |
| Public deployment | Read-only verified | `topgjournal.netlify.app` serves `GoldJournal_EA.mq5` with `#property version "2.1"` and `SyncSeconds = 3` |
| Supabase production state | Not directly queried | Run the included `supabase/verify_production_mt5_contract.sql` in the project’s SQL Editor |
| Authenticated MT5 smoke test | Outstanding operator action | Requires live MT5 terminal, API key, and Supabase project |

## Required 25-item report

### 1. Exact root cause

There were two independent correctness failures. First, the server RPC wrapper called `gj_sync_mt5_position` with the JSON argument name `position`, while the PostgreSQL function signature is `position_payload`; PostgREST consequently returned a routine-resolution failure classified to the client as `SYNC_UNAVAILABLE`. The wrapper now sends the exact `position_payload` key in `server/atomicOperations.ts`, and `server/atomicOperations.test.ts` asserts that contract. Second, the EA derived historical direction from the closing deal type. A BUY position normally closes with a SELL deal and a SELL position normally closes with a BUY deal, so the old EA inverted direction. EA v2.1 reconstructs direction from entry deals and aggregates the complete position history by position ID. [1] [2]

### 2. Exact files changed

The repair range from the production-hardening baseline through commit `784a812` changed the following production, test, schema, and documentation files:

| Area | Files |
|---|---|
| MT5 client and UI | `client/public/GoldJournal_EA.mq5`, `client/src/components/Mt5LiveView.tsx`, `client/src/components/Mt5LiveView.test.tsx` |
| MT5 server path | `netlify/functions/api.ts`, `server/_core/index.ts`, `server/mt5Http.ts`, `server/mt5Ingest.ts`, `server/mt5Db.ts`, `server/atomicOperations.ts`, `server/goldRouter.ts`, `server/supabaseQuery.ts` |
| Regression tests | `server/mt5EaContract.test.ts`, `server/mt5Ingest.test.ts`, `server/mt5Route.test.ts`, `server/atomicOperations.test.ts`, `server/supabaseQuery.test.ts`, `server/supabase.integration.test.ts` |
| Tenant and analysis hardening | `drizzle/schema.ts`, `server/analysisDb.ts`, `server/analysisAi.ts`, `server/aiReportDb.ts`, `server/rateLimit.ts`, associated tests, and `shared/analysisEngine.ts` with tests |
| Production SQL | `supabase/migrations/0004_atomic_operations.sql`, `supabase/migrations/0008_production_integrity_and_analysis.sql`, `supabase/migrations/0009_ai_report_history.sql`, `supabase/migrations/0010_fix_mt5_rpc_trade_insert_arity.sql`, `supabase/verify_production_mt5_contract.sql` |
| App resilience and safety | `client/src/pages/GoldJournal.tsx`, `client/src/lib/accountScope.ts`, account/analysis/Trade Dialog components and tests, removal of the unreferenced `client/public/__manus__/debug-collector.js`, and `scripts/schema-source-audit.mjs` |
| Documentation | `README.md` and the audit reports under `deliverables/` |

### 3. Exact database migration(s) changed

The repair changes `0004_atomic_operations.sql` and `0008_production_integrity_and_analysis.sql` so fresh installations contain the correct `gj_trades` INSERT arity. Migration `0009_ai_report_history.sql` remains the AI history migration. New forward migration `0010_fix_mt5_rpc_trade_insert_arity.sql` replaces the already-deployed RPC body for projects that previously applied a defective 0008/0004 function. The repository schema audit now validates migrations 0001 through 0010. [3] [4]

### 4. Exact function(s) changed

The MT5 synchronization chain changed in `syncMt5PositionAtomic` (`server/atomicOperations.ts`), `upsertMt5ClosedPosition` and related open-position helpers (`server/mt5Db.ts`), `processMt5Payload` and history/open-batch handling (`server/mt5Ingest.ts`), and the Supabase RPC `public.gj_sync_mt5_position` in migrations 0004, 0008, and 0010. Error metadata preservation was hardened in `server/supabaseQuery.ts`; PostgreSQL 42601 is now classified as a migration/RPC defect with migration 0010 guidance. The Trade Log pre-sync path in `goldRouter.ts` now preserves the main journal response and returns actionable sync diagnostics instead of crashing the whole view.

### 5. Exact reason account snapshot worked

The account snapshot and open-position summary use the EA’s summary/open-batch path and do not require the closed-history position payload to invoke `gj_sync_mt5_position` for a terminal Trade Log row. The snapshot was therefore able to reach the HTTP endpoint and return account metrics even while historical synchronization failed at the RPC contract boundary. The repaired path keeps this separation: account metrics can be displayed, but a closed position is written only through the server-side Supabase RPC.

### 6. Exact reason history failed

History had two sequential blockers. The earlier server wrapper used `position` instead of `position_payload`, causing PGRST202 routine resolution failures. After that wrapper fix, the deployed RPC body still had a malformed `INSERT INTO public.gj_trades`: the target list contained 28 columns, but the VALUES list omitted the empty `holdQuality` expression before `patienceScore`. PostgreSQL therefore returned provider code 42601 when a CLOSED history record reached the Trade Log branch. The v2.1 EA also corrects the independent data-quality issue in the old history reconstruction logic.

### 7. Exact reason Trade Log remained empty

A Trade Log row is created only when the RPC receives a position with `status = 'CLOSED'`. The failed history batch never reached the RPC’s CLOSED branch, so no `gj_trades` row was inserted. The repaired RPC still has one authoritative CLOSED insertion/update path; it does not add a browser fallback or a second direct insertion path. Replays use the unique account/ticket conflict target and update the existing row.

### 8. Whether production Supabase schema was behind GitHub

The repository proves that the required RPC and migrations exist in GitHub, but the available session did not directly query the user’s live Supabase project. Therefore, production schema lag is **not claimed as proven**. The observed PGRST202 routine-resolution failure led to the named-argument fix; the new observed provider code 42601 proves a second defect in the deployed RPC body. Production schema lag is still not claimed without a live SQL query. Apply migration 0010 after 0008/0009 and run `supabase/verify_production_mt5_contract.sql` to establish the live state.

### 9. Whether `gj_sync_mt5_position` existed

In the repository, the function is defined in 0004, replaced in 0008, and repaired forward in 0010. Live existence was not directly queried from the operator’s Supabase project in this session. The verification SQL returns the function definition, identity arguments, security-definer status, and function configuration so the operator can confirm that migration 0010 is active.

### 10. Whether the RPC signature matched

The intended and corrected signature is `public.gj_sync_mt5_position(integer, integer, jsonb)` with named arguments `target_user_id`, `target_account_id`, and `position_payload`. The server now uses those exact names. `server/atomicOperations.test.ts` proves the wrapper’s outgoing argument contract; the included SQL verification proves the deployed signature when run against Supabase.

### 11. Exact PostgreSQL/Supabase error encountered

The latest user-visible error was `History batch failed: SYNC_UNAVAILABLE: Supabase returned provider code 42601; inspect the Netlify function log for its redacted details.` PostgreSQL 42601 is the syntax-error class caused here by the 28-column/27-expression `gj_trades` INSERT in the deployed RPC body. Earlier history failures also included PGRST202 from the `position`/`position_payload` mismatch. The adapter preserves provider code, details, and hint; `server/mt5Ingest.ts` now classifies 42601 as a migration-specific failure and tells the operator to apply 0010.

### 12. Exact fix applied

The exact fixes are: (1) send `position_payload` from `syncMt5PositionAtomic`; (2) add the missing `holdQuality` empty expression to the 28-column Trade Log INSERT in 0004 and 0008; (3) add forward migration 0010 to replace the defective RPC in existing deployments; (4) classify provider code 42601 with actionable migration guidance; and (5) add arity regression tests in `server/schemaIntegrity.test.ts`. The open-batch Zod schema, sequential writes, Supabase metadata preservation, idempotency, ownership checks, and single authoritative RPC path remain intact.

### 13. MT5 EA changes

`GoldJournal_EA.mq5` is now v2.1. Historical collection is position-based: it gathers closed position IDs, calls `HistorySelectByPosition()` for each ID, reconstructs one record from all entry/exit deals, and sends bounded batches of 50 positions. It emits an explicit successful empty history batch with `complete:true`, carries broker UTC offset and compatibility metadata, keeps `ConnectionId` optional, and aborts rather than silently discarding an unreconstructable position. The dashboard and tests now identify the downloadable contract as v2.1.

### 14. Direction-handling fix

The EA now derives the original position direction from `DEAL_ENTRY_IN` deals. A normal BUY entry maps to BUY even when its exit deal is SELL; a normal SELL entry maps to SELL even when its exit deal is BUY. For reversal entries (`DEAL_ENTRY_INOUT`), the EA takes the opposite of the reversal deal type. `server/mt5EaContract.test.ts` asserts the source contract for entry-based direction reconstruction and rejects the old closing-deal approach.

### 15. Timestamp handling

The EA sends broker timestamps together with `broker_utc_offset_minutes`. Server parsing in `server/mt5Ingest.ts` applies the validated offset and stores UTC instants. Migration 0008 persists `openTime` and `closeTime` as `timestamptz`; the RPC retains an existing open time when a later replay omits it and uses the closed payload’s close time for realized records. Frontend rendering remains local-time display over UTC-backed values.

### 16. Idempotency behavior

The MT5 live-position identity is `(accountId, ticket)`, and the RPC uses `ON CONFLICT` update semantics. A CLOSED live-position row is terminal: a replayed or stale OPEN event cannot reopen it. The realized Trade Log uses the unique `(accountId, mt5Ticket)` conflict target, so one ticket produces one journal row per account. Replaying the same history batch updates the existing row rather than inserting a duplicate. Sequential account-scoped writes avoid concurrent batch races without adding a second insertion path.

### 17. Security and tenant-isolation verification

The server derives the target user from the authenticated/account-scoped connection context and passes it to the SECURITY DEFINER RPC; the RPC locks and verifies the `(accountId, userId)` ownership pair before writing. Migration 0008 adds composite ownership foreign keys across account-scoped tables. The browser does not receive the Supabase service-role key, OpenRouter key, MT5 encryption key, or server-only configuration. RLS and service-role-only grants remain enabled for the sensitive production tables. Automated account-scope tests and the optional Supabase integration test cover cross-account identifier substitution when staging credentials are supplied.

### 18. Tests added

The new EA contract suite is `server/mt5EaContract.test.ts`; it covers entry-based direction, SL/TP preservation, commission/swap/fee-inclusive P&L source usage, position aggregation/bounded batching, empty history completion, and no-silent-discard behavior. `server/schemaIntegrity.test.ts` now parses the 0004/0008/0010 RPC INSERT lists and rejects column/value arity drift. `server/mt5Ingest.test.ts` covers provider code 42601 and migration 0010 guidance. Existing atomic, Supabase adapter, and MT5 Live UI tests continue to cover the earlier fixes.

### 19. Test results

The full Vitest run completed with **68 test files passed, 1 opt-in integration file skipped; 219 tests passed, 2 opt-in Supabase integration tests skipped**. The skipped tests require live staging identifiers and were not falsely represented as production execution. The focused MT5/RPC/schema/UI gate completed with **6 files passed and 39 tests passed**.

### 20. `pnpm check` result

`pnpm check` passed with `tsc --noEmit` and no TypeScript errors after the EA v2.1 dashboard/test updates.

### 21. `pnpm test` result

`pnpm test` passed as recorded in item 19. The full suite includes server, client, shared analytics, account scope, authentication/session recovery, PWA, storage, rate limiting, and MT5 synchronization coverage.

### 22. `pnpm build` result

`pnpm build` passed. Vite transformed 2,075 modules and produced the client plus bundled server output. The build emitted a non-fatal existing warning for a JavaScript chunk larger than 500 kB; it did not fail the release and remains a performance follow-up rather than a correctness exception.

### 23. Netlify deployment verification

The public Netlify site was checked read-only. The unauthenticated site shell at `https://topgjournal.netlify.app/` loaded and presented the Supabase-backed sign-in page. The public `GoldJournal_EA.mq5` download was fetched through the browser and reported `#property version "2.1"`, `SyncSeconds = 3`, and an empty default `ConnectionId`, confirming that the v2.1 asset is live at the public download URL. This does not substitute for an authenticated MT5 smoke test.

### 24. Supabase production verification

The live Supabase project was not directly queried because this task did not have an authenticated SQL Editor or project-level integration session. The repository-side schema audit must now pass with migrations 0001–0010 ordered. The operator must apply/reconfirm 0008, 0009, and 0010, reload the PostgREST schema cache, and run `supabase/verify_production_mt5_contract.sql`. The required live result is `gj_sync_mt5_position(integer, integer, jsonb)` with `position_payload`, a 28-column/28-expression Trade Log INSERT, SECURITY DEFINER, and service-role execution only.

### 25. Exact remaining risks

The remaining risks are operational, not untested source changes. First, migrations 0008, 0009, and 0010 may still need to be applied in the correct Supabase project, followed by a PostgREST schema reload. Second, the operator must compile the EA in MetaEditor, remove the old chart instance, attach v2.1, configure the endpoint/API key/broker offset, and leave `ConnectionId` blank unless intentionally using a real connection. Third, the authenticated end-to-end scenario—sign-in, active connection, history batch, Supabase write, Trade Log display, replay, correct direction/P&L, and account isolation—must be exercised with real user/account data. Finally, the large frontend chunk warning should be addressed in a separate performance change; it is not a synchronization correctness failure.

## Operator runbook

| Order | Action | Expected result |
|---:|---|---|
| 1 | Apply `0008_production_integrity_and_analysis.sql` after 0001–0007. | MT5 RPC, composite ownership, analysis fields, and distributed limiter exist. |
| 2 | Apply `0009_ai_report_history.sql`. | AI history tables exist with RLS and service-role-only grants. |
| 3 | Apply `0010_fix_mt5_rpc_trade_insert_arity.sql`. | The live RPC has 28 Trade Log target columns and 28 value expressions, including `holdQuality`. |
| 4 | Reload Supabase PostgREST schema cache. | Named RPC calls resolve using the current signature. |
| 5 | Run `supabase/verify_production_mt5_contract.sql`. | Function signature, 28/28 arity, and constraints match the expected contract. |
| 6 | Download and compile `GoldJournal_EA.mq5` v2.1 in MetaEditor. | MetaEditor compiles without errors; attach only the new EA instance. |
| 7 | Configure endpoint, one-time API key, broker offset, and optional blank ConnectionId. | MT5 sends summary/open/history requests to `/api/mt5`. |
| 8 | Retry history and replay the same batch. | One Trade Log row per ticket; no duplicates; CLOSED remains terminal. |
| 9 | Verify two accounts and direction/P&L edge cases. | No cross-account visibility; BUY/SELL, SL/TP, timestamps, and fee-inclusive P&L are correct. |

## References

[1]: https://github.com/Najam27/gold-journal-/commit/784a81272b97a617355ce6a2306568d5d610aff6 "EA v2.1 release commit"

[2]: https://github.com/Najam27/gold-journal-/blob/784a81272b97a617355ce6a2306568d5d610aff6/server/atomicOperations.ts "Atomic Supabase RPC wrapper"

[3]: https://github.com/Najam27/gold-journal-/blob/784a81272b97a617355ce6a2306568d5d610aff6/supabase/migrations/0008_production_integrity_and_analysis.sql "Production integrity and MT5 RPC migration"

[4]: https://github.com/Najam27/gold-journal-/blob/784a81272b97a617355ce6a2306568d5d610aff6/supabase/migrations/0009_ai_report_history.sql "AI report history migration"

[5]: https://github.com/Najam27/gold-journal-/blob/784a81272b97a617355ce6a2306568d5d610aff6/client/public/GoldJournal_EA.mq5 "Gold Journal EA v2.1 source"

[6]: https://github.com/Najam27/gold-journal-/blob/784a81272b97a617355ce6a2306568d5d610aff6/server/mt5EaContract.test.ts "EA source-contract regression tests"

[7]: https://topgjournal.netlify.app/ "Gold Journal public deployment"
