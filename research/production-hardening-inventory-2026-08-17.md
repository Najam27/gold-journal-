# Gold Journal Production-Hardening Inventory — 17 August 2026

## Scope Guard

This inventory follows the supplied brief: it preserves the existing application architecture, UI, workflows, PWA behavior, and fixed Pakistan-time MT5 semantics. In particular, MT5 business dates, sessions, monthly reporting, and journal labels must continue using **UTC+5 / Asia/Karachi**. No production data was changed during this inventory.

## Confirmed Current State

| Area | Evidence | Hardening implication |
|---|---|---|
| Runtime configuration | `server/_core/env.ts` currently falls back to empty strings for JWT, database, OAuth, and Forge values; `server/db.ts` can silently return no database. | Add an explicit production-only validation boundary that reports only missing variable names and fails before requests are served. Preserve convenient development startup. |
| Global parsing | `server/_core/index.ts` correctly limits `/api/mt5` JSON to 256 KB, but leaves global JSON and URL-encoded parsing at 50 MB. | Reduce global application body limits while retaining the existing direct storage upload path. |
| MT5 API keys | New keys are stored as a SHA-256 verifier, returned once only during creation, and excluded from workspace mappers. Legacy plaintext keys migrate on a successful request. | Keep verifier design—server never needs to recover/send a key after initial creation—and audit error/log paths rather than replacing it with unnecessary encryption. |
| MT5 rate limiting | `server/mt5Ingest.ts` uses verifier fingerprints, a one-second expiry sweep, and a 2,000-entry hard bound. | Existing mitigation addresses the unbounded raw-key map risk; add targeted tests for expiry/eviction and ensure malformed requests cannot persist raw keys. |
| MT5 ordering/idempotency | `server/mt5Db.ts` has account-ticket unique keys, transactions, terminal CLOSED guards, and atomic journal synchronization. | Existing logic already prevents delayed OPEN from reopening CLOSED. Extend regression coverage only where a verified edge remains. |
| MT5 timestamps | `mt5Timestamp.ts` formats business output as `+05:00`; PKT session detection uses Asia/Karachi. It currently accepts explicit instants and offset-free broker-local payloads through a connection offset. | Preserve the fixed UTC+5 business convention. Any adjustment must not change existing configured timestamps, sessions, or date/month outcomes. |
| Account lifecycle | `accounts.remove` deletes dependent data sequentially without a transaction. `ensureAccount` is select-then-insert. | Make deletion transactional and make default-account bootstrap safe against concurrent first requests using an additive database constraint/migration if required. |
| Journal payload | `getJournal()` loads every trade for the active account and eagerly hydrates screenshot URLs. `trades.list` is already paginated. | Preserve legacy dashboard behavior while moving summary/analytics to lightweight server data and retaining the paginated list as the browser’s trade source. |
| Response privacy | `journalPrivacy.ts` removes ownership IDs, timestamps, screenshot keys/names, and MT5 tickets from browser-facing trade records. MT5 workspace maps fields explicitly and omits the verifier. | Continue explicit mappers and audit remaining mutations such as screenshot upload, which currently returns a storage key and URL. |
| Goal formulas | `client/src/lib/traderGoals.ts` is the richer PKT-aware goal engine. `server/goldRules.ts` is a smaller, non-equivalent evaluator. | Extract only the shared status primitive first, retaining the client engine’s established strategy and period calculations. |
| Date/month reporting | `performanceSummary.ts` uses browser-local getters, unlike the PKT-aware goal and MT5 helpers. | Replace localized browser-local month/week comparisons with the existing fixed Pakistan-time utility pattern and add boundary tests. |
| Type safety | The main Gold Journal source is still legacy-large and contains broad `any` helpers, but no `@ts-nocheck`/`@ts-ignore` file-level suppression was found. | Retain the current TypeScript configuration; reduce broad `any` only at high-risk boundaries in future scoped work rather than perform a speculative rewrite. |

## Existing Protections Retained

The current implementation already uses account-scoped query checks, unique MT5 `(accountId, ticket)` keys, journal-safe response mappers, per-route MT5 request sizing, SHA-256 key verifiers, a bounded MT5 limiter, and transaction-based MT5 terminal transitions. The hardening pass will preserve these protections and close only confirmed gaps.

## Planned Safe Sequence

1. Add production configuration validation and safe logging/header/body-parser controls.
2. Add account-bootstrap uniqueness and transactional account removal through reviewed additive migration(s).
3. Refactor journal summaries from unbounded payloads while preserving paginated list/search/export behavior.
4. Replace browser-local performance month/week keys with fixed UTC+5 calculations and add boundary regressions.
5. Complete the response/privacy and MT5 regression audit without changing the current EA contract or UTC+5 journal behavior.

## Reviewed Implementation Design

The first hardening change set will stay additive and narrow. A `validateRuntimeConfiguration()` boundary will fail fast only for production startup, checking the required names rather than logging values. The server will reduce its non-MT5 JSON and URL-encoded parser limits to 1 MB, retain the existing 256 KB MT5 route limit, and return generic parser errors. Standard non-breaking response headers will be added without a restrictive Content-Security-Policy.

Account bootstrap will receive a nullable `bootstrapKey` column and a unique `(userId, bootstrapKey)` index. Ordinary user-created accounts keep a null key, while the first automatic account uses `PRIMARY`; a duplicate-key race safely falls back to selecting that one account. The pre-migration duplicate checks found no duplicate `(userId, name)`, MT5 `(accountId, ticket)`, or journal `(accountId, mt5Ticket)` rows. Account deletion will run all owned dependent deletions and the account deletion in one transaction.

Monthly and weekly client performance keys will move to the application’s existing fixed Pakistan-time date helpers. This change affects only business-date grouping—not stored timestamps, the EA payload contract, session definitions, or the UTC+5 representation. The current hashed MT5 verifier, bounded fingerprint limiter, transaction-based OPEN/CLOSE guards, and safe workspace mapper will be retained and strengthened with coverage rather than replaced.

## Implemented Corrections

The completed implementation adds production-only environment validation, generic unexpected-error masking, safe startup/error logging, standard response headers, a 256 KB MT5 parser, a 10 MB authenticated screenshot parser, and 1 MB default JSON and URL-encoded parsers. Screenshot upload responses now omit the internal storage key. The non-destructive account migration `0008_uneven_trauma.sql` adds `bootstrapKey` plus a nullable unique `(userId, bootstrapKey)` constraint; it is applied to the managed database.

Account deletion now executes all dependent deletes and the account delete inside one transaction. Automatic first-account creation now uses the bootstrap uniqueness key to make concurrent first requests converge on one primary account. The ordinary journal payload is bounded to the 500 most recent records instead of loading the full history. The separate bulk PDF workflow deliberately fetches each already-paginated server page only after the trader clicks download, preserving full active-account exports while avoiding an automatic full-history fetch.

Performance grouping and bulk-PDF date filters now use fixed PKT date keys. The service-worker generation has advanced from `v8` to `v9` so installed and returning users activate the hardened client. New regressions cover production-secret validation, transactional account removal, storage-key-free screenshot responses, PKT month/week boundaries, and explicit paginated report retrieval.
