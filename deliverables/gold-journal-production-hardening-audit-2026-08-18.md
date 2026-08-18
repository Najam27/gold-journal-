# Gold Journal Production Hardening Audit

**Repository:** [Najam27/gold-journal-](https://github.com/Najam27/gold-journal-)

**Application:** [topgjournal.netlify.app](https://topgjournal.netlify.app/)

**Audit date:** 18 August 2026

**Release commit:** `87ef529` — `Production hardening: integrity, MT5 v2, AI evidence, and rate limiting`

## Executive Summary

Gold Journal was audited and rebuilt as a Supabase-only, account-scoped trading journal rather than a UI-only demonstration. The hardening work covered the repository, migration chain, ownership boundaries, balance semantics, MT5 ingestion and replay, deterministic analytics, AI evidence grounding, PWA behavior, distributed rate limiting, dead-code removal, and automated validation. The changes were committed and pushed directly to `origin/main`.

The release gate passed with TypeScript checking, migration/schema auditing, the complete automated suite, and production builds. The automated suite now reports **67 passing test files, 1 intentionally skipped integration file, 202 passing tests, and 2 skipped integration tests**. Production deployment still requires the operator to apply migrations 0008 and 0009 in Supabase and perform the live Netlify/MT5 smoke checks listed below; those actions were not claimed as completed from the sandbox.

> **Important distinction:** the repository is hardened and release-ready in source control, but the new database migrations are not automatically applied to the production Supabase project by this task.

## Release Gate

| Check | Result | Notes |
|---|---:|---|
| `pnpm check` | PASS | TypeScript `--noEmit` completed successfully after removing `@ts-nocheck`. |
| `pnpm schema:audit` | PASS | Migration order 0001–0009, canonical schema names, stale Drizzle artifacts, and integrity checks validated. |
| `pnpm test` | PASS | 67 files passed, 1 opt-in integration file skipped; 202 tests passed, 2 skipped. |
| `pnpm build` | PASS with warning | Vite frontend and Netlify/server bundle built successfully. One frontend chunk remains larger than 500 kB and is recorded as a performance follow-up. |
| `git diff --check` | PASS | No whitespace errors. |
| GitHub push | PASS | `main` advanced from `ed33f69` to `87ef529`. |

## 28-Phase Findings and Fixes

### 1. Repository inventory and ownership

The repository was inventoried across client, server, shared, Supabase, Netlify, scripts, tests, generated output, and research artifacts. Active production code was separated from historical research and generated build output. The final changes are limited to production source, migrations, tests, the EA asset, and the audit report.

### 2. Placeholder and dead-code review

The main journal page no longer carries `// @ts-nocheck`. Shadowed embedded implementations of the legacy plan, trade log, analysis, goals, calendar, and duplicate plan views were removed. The active page now routes to the imported production components such as `TradeLogWithViewer`, `AnalysisDashboard`, `FlexibleGoalsView`, `PnlCalendarWithWeeks`, and `PlanExecutionEditor`.

### 3. Runtime and deployment boundary

The active backend remains Supabase-only through the PostgREST adapter and Supabase Auth/Storage. No `DATABASE_URL` path was reintroduced. Netlify and the local Express server both expose the MT5 compatibility route through the same server registration path.

### 4. Migration chain integrity

The migration chain is now explicitly audited as **0001 through 0009**. The schema-source audit verifies migration order, expected migration names, stale Drizzle migration artifacts, critical indexes, constraints, and the qualified trade-summary hotfix.

### 5. PostgreSQL semantics and aggregate correctness

The existing trade-summary RPC ambiguity was corrected in migration 0007 using qualified aliases for `result`, `pnl`, `userId`, and `accountId`. Migration 0008 adds analysis columns and ownership constraints. Migration 0009 adds durable AI history with explicit JSONB shape checks and named composite constraints.

### 6. Security-definer and privilege hardening

New security-definer functions in migration 0008 use `set search_path = public`, validate ownership, and are revoked from `public`, `anon`, and `authenticated`. Only `service_role` receives execution grants. The rate-limit table and AI history tables are not directly available to browser roles.

### 7. Composite account ownership

Migration 0008 preflights existing ownership mismatches before adding composite foreign keys. Account-scoped tables now require the `(accountId, userId)` pair to match the referenced account owner. This prevents a valid account identifier from being combined with a different user identifier.

### 8. Account management and concurrent removal

The authenticated `accounts.list`, `accounts.create`, `accounts.rename`, and removal flow remain independent of the journal query. The removal RPC locks the user row before counting accounts, enforces the minimum-one-account invariant, locks the target account, and returns a replacement account identifier. Options and account rename functionality are no longer hidden behind journal-derived loading failures.

### 9. Account isolation across features

Server-side ownership checks remain mandatory for trades, cash movements, goals, plans, skipped trades, notifications, MT5 connections, screenshots, analysis, and AI history. New AI history procedures verify ownership before reading or updating reports and experiments. The opt-in Supabase integration test explicitly exercises cross-account identifier substitution when configured with staging identifiers.

### 10. Balance and P&L semantics

Starting balance, cash movements, realized journal P&L, and MT5 floating P&L remain distinct. Journal balance uses starting balance plus deposits/withdrawals plus realized trade P&L. Core journal data is returned even when derived trade-summary or cash-net calculations fail. Derived failures are surfaced as a retryable status rather than silently replaced with fabricated values.

### 11. Idempotency and ledger integrity

MT5 journal rows use account/ticket identity and update semantics rather than creating duplicates. A closed MT5 position is terminal: replayed or stale OPEN events cannot reopen it. Manual trade ownership and account movement checks remain server-side.

### 12. MT5 Expert Advisor rebuild

`client/public/GoldJournal_EA.mq5` was rebuilt as EA v2.1. It reports account summaries, batched open positions, close events, historical batches, broker UTC offset, compatibility metadata, and completion markers. History pagination uses a bounded cursor contract, and repeated history records are keyed by position identity.

### 13. MT5 ingest contract and compatibility

The ingest layer now supports `compat`, `open_batch`, per-payload broker offset overrides, parallel history batch processing, and version metadata in responses. A dedicated `/api/mt5/compat` endpoint is registered in both Netlify and local server entry points.

### 14. MT5 replay, timestamps, and close truth

The ingest and database layers preserve broker close facts, distinguish open from closed state, and classify timestamps using the provided broker UTC offset. Stored timestamps remain UTC. The journal mirror now queries closed positions only and returns the actual synchronized count rather than counting skipped OPEN rows.

### 15. MT5 polling consolidation

The sidebar no longer issues a second background MT5 workspace query. It receives the already account-scoped MT5 summary from the main journal orchestration query. Polling remains active only for the trades and MT5 views where live data is needed.

### 16. Analysis data completeness

`gj_trades` and the canonical Drizzle schema now include `openTime`, `closeTime`, `mfe`, and `mae`. Analysis selection includes these fields and retains duration and excursion inputs for deterministic analytics.

### 17. Analytics timezone and metric math

Trader-facing day/hour/session grouping uses `Asia/Karachi`; stored instants remain UTC. The after-WIN and after-LOSS risk metrics now measure the next trade after the outcome, not the risk of the winning or losing trade itself. Analysis loading applies server-side date, session, timeframe, level, setup, direction, and result filters.

### 18. Evidence tiers and edge selection

Evidence tiers now distinguish `OBSERVED BEST CONTEXT`, `POTENTIAL EDGE`, `DEVELOPING EDGE`, `REPEATABLE EDGE`, and `VALIDATED EDGE`. Edge cards are restricted to positive-expectancy contexts, so a negative-expectancy context cannot be presented as a top edge.

### 19. AI evidence grounding

The AI contract now requires deterministic evidence IDs in the form `ev-` plus a SHA-256-derived digest. Every evidence item is checked against exact supplied dimension, context, sample, wins, losses, expectancy, profit factor, average R, drawdown, and tier values. Hypotheses must cite valid evidence IDs, and market signals, price targets, BUY/SELL prompts, and guaranteed-return language are rejected.

### 20. AI report persistence

Migration 0009 adds immutable `gj_ai_reports`, `gj_ai_edge_history`, and `gj_ai_experiment_history` tables. Reports are fingerprinted by deterministic analysis data, inserted idempotently, and account-scoped. Authenticated procedures expose report history, experiment history, and ownership-checked experiment status updates. If the migration has not yet been applied, AI analysis remains available but reports are marked as not persisted and the server emits a degradation warning.

### 21. Query performance and pagination

Analysis loading uses keyset pagination over `(tradeDate, id)` rather than OFFSET and caps the source at 10,000 trades. It pushes filters into the database query and selects only analysis fields. The schema audit requires account/date/result indexes for the analysis path.

### 22. Distributed rate limiting

AI analysis, screenshot uploads, goal-alert writes, and MT5 ingest use the shared asynchronous limiter. Production calls the Supabase `gj_consume_rate_limit` RPC, whose row-level upsert is atomic for each scope and hashed identity. The local in-memory limiter remains available only when Supabase is not configured. A configured RPC failure now fails closed rather than silently bypassing the distributed protection.

### 23. Storage and upload security

Existing screenshot handling remains behind authenticated trade ownership, MIME allowlisting, image signature checks, payload size limits, and private storage signed URLs. No service-role credential is sent to the browser. The current hardening release does not weaken those controls.

### 24. PWA and service-worker hardening

The service worker uses a versioned static cache, deletes older caches during activation, does not cache API, storage, cross-origin, non-GET, or unsupported request destinations, and uses network-first behavior with a static fallback. The update banner waits for explicit user action and guards against duplicate reloads and reload loops.

### 25. Debug and production artifact cleanup

The unreferenced `client/public/__manus__/debug-collector.js` asset was deleted because it could observe network requests and form values. Active client source contains no stale EA v1.10/v1.12/v1.14 labels and no remaining `@ts-nocheck` directive. Historical research notes may still mention old versions, but they are not shipped application code.

### 26. Automated and failure-injection testing

The full suite covers authentication state transitions, account scope, journal statistics, MT5 timestamps and ingest, storage, rate limiting, analytics, AI validation, PWA updates, and the client views. New tests cover AI persistence, distributed limiter failure injection, and optional real Supabase account isolation. Existing synthetic scale tests remain part of the suite.

### 27. Release truthfulness and deployment surface

The MT5 Live UI now labels the downloadable EA and setup guide as v2.1. The application does not claim that AI persistence is active when the migration is absent; it returns a persistence status. The production build completes for both the Vite client and server bundle. A chunk-size warning remains visible and is recorded as a follow-up rather than hidden.

### 28. Operator deployment and manual verification

The final operator sequence is documented below. Applying the migrations, compiling the EA in MetaEditor, and performing a live Netlify/MT5 smoke test are required before declaring the production data path fully exercised.

## Required Operator Actions

| Order | Action | Expected verification |
|---:|---|---|
| 1 | In Supabase SQL Editor, apply `supabase/migrations/0008_production_integrity_and_analysis.sql` after migrations 0001–0007. | The ownership constraints validate, `gj_consume_rate_limit` exists, analysis columns exist, and the MT5 sync function is replaced. |
| 2 | Apply `supabase/migrations/0009_ai_report_history.sql`. | AI report, edge-history, and experiment-history tables exist with RLS enabled and service-role-only grants. |
| 3 | Run the SQL checks for `gj_consume_rate_limit`. | Repeated calls for one scope/hash allow up to the limit, reject the next call, and allow a new window after expiry. |
| 4 | Send a v2.1 MT5 OPEN event. | It appears in `gj_mt5_live_positions` as OPEN and does not create a realized `gj_trades` row. |
| 5 | Send the corresponding CLOSE event and replay the batch. | Exactly one realized journal trade exists with broker close facts; replay does not duplicate or reopen it. |
| 6 | Compile and attach `GoldJournal_EA.mq5` in MetaEditor. | The EA reports compatibility v2.1, account summary, open positions, position-aggregated closed history, broker offset, original direction, historical SL/TP where available, fee-inclusive realized P&L, and completion markers. |
| 7 | Verify a two-account user in the deployed app. | Changing accounts changes every scoped query; malicious account identifiers are rejected server-side. |
| 8 | Open AI Analysis after migration 0009. | A validated report receives a persistence identifier and appears under authenticated history for that account only. |
| 9 | Perform the live PWA update check. | The user sees an update banner and the app reloads once only after clicking Update now. |

## Known Limitations and Follow-Ups

The repository cannot apply Supabase migrations without the operator's project session, so database deployment remains an explicit action. The real Supabase integration test is intentionally skipped unless `GOLD_JOURNAL_INTEGRATION=1`, `GJ_INTEGRATION_USER_A`, `GJ_INTEGRATION_ACCOUNT_A`, and `GJ_INTEGRATION_ACCOUNT_B` are supplied for a staging project. MetaEditor is not available in the Ubuntu build environment; the EA must be compiled and attached in MT5. A live browser smoke test against Netlify was not represented as completed by the automated release gate.

The production Vite build still reports a chunk larger than 500 kB. This is a performance warning, not a build failure; the next optimization should split the large application bundle and defer additional view code. Existing synthetic scale tests exercise bounded scenarios, but no external 5,000-user load run was claimed. Finally, operator verification should confirm the Supabase project has the expected service-role grants and that no old migration was partially applied before 0008 or 0009.

## Files of Highest Operational Importance

| File | Purpose |
|---|---|
| `supabase/migrations/0008_production_integrity_and_analysis.sql` | Composite ownership, concurrent account removal, MT5 OPEN/ CLOSE semantics, analysis columns, and distributed rate limiter. |
| `supabase/migrations/0009_ai_report_history.sql` | Durable AI report, evidence, and experiment history. |
| `client/public/GoldJournal_EA.mq5` | MT5 EA v2.1 contract implementation. |
| `server/mt5Ingest.ts` and `server/mt5Db.ts` | MT5 compatibility, replay, idempotency, and realized-P&L mirroring. |
| `shared/analysisEngine.ts` and `server/analysisDb.ts` | PKT analytics, corrected metrics, evidence tiers, filters, and bounded keyset loading. |
| `server/analysisAi.ts` and `server/aiReportDb.ts` | Evidence-grounded AI validation and durable report persistence. |
| `server/rateLimit.ts` and `supabase/migrations/0008_production_integrity_and_analysis.sql` | Distributed rate limiting and fail-closed production behavior. |
| `scripts/schema-source-audit.mjs` | CI-style migration and canonical schema consistency audit. |
