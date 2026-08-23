# Gold Journal Commit-by-Commit MT5 Regression Audit

**Audit scope:** all 93 reachable Git commits on `main`, reviewed chronologically on 2026-08-23.

## Method

The audit uses two repository scripts. `scripts/mt5-history-inventory.mjs` inventories every commit and classifies changed paths across MT5, account state, Supabase, Netlify, PWA, authentication, and frontend layers. `scripts/mt5-lifecycle-regression-audit.mjs` compares the relevant historical snapshots for account-scoped key creation, destructive connection removal, workspace ownership filters, API-key owner normalization, EA endpoint mode, Netlify EA routing, and MT5 migration availability.

The full history currently contains **93 commits**. The deterministic path classifier identifies **42 commits** touching the focused MT5 lifecycle path and 34 touching Supabase/migrations. A path classification is not a claim that each commit introduced a defect; it identifies commits requiring source comparison.

## Chronological Findings

| Interval / commit | Verified source behavior | Audit result |
|---|---|---|
| `ce48e4f` through `a52efc3` | The workspace read required both `connection.userId` and `connection.accountId`, while API-key ingestion authenticated by key and active state. | **Lifecycle contradiction.** A legacy/copied connection row with a stale denormalized `userId` could accept EA events but remain invisible to the selected account UI. |
| `d1e1b7c` | Added reconnect/key-replacement behavior and retained destructive `delete(mt5Connections)`. | **Regression risk.** Replacement intentionally invalidates the old one-time key and clears first-contact/metrics. Destructive delete could leave account-scoped history while removing the live connection record. |
| `91d4b93` / `a52efc3` | Added first-contact recovery/rotation UX. Rotation resets the key, `lastContactAt`, snapshot fields, and sync-health fields. | **Correct security behavior, incomplete lifecycle UX.** A user who rotates/replaces a key but keeps the prior key in EA correctly lands in `WAITING FOR MT5`; the source did not make that state sufficiently distinct from a transport failure. |
| `ca5f6df` | Replaced normal physical connection deletion with non-destructive retirement. | **Fix.** Future normal retirements preserve the row and account-scoped journal history, but the workspace owner-filter contradiction still remained. |
| `292ad19` | Replaced a fixed downloadable EA endpoint with a same-deployment generated endpoint. | **Fix with temporary deployment risk.** A first implementation could make the function unavailable when the template loader failed. |
| `82de80f` | Made EA-template loading lazy and non-fatal. | **Fix.** A missing template can no longer prevent MT5/tRPC API startup. |
| `e7bb922` | Canonicalized `mt5Connections.userId` from the owned account before workspace/API-key use; migration 0018 repairs stale rows. | **Root-cause repair.** Resolves the successful-EA-but-hidden-selected-account condition without moving trades/history. |
| `f70c0d8` | Added narrow Netlify scanner omissions for a public bucket name and public redirect origin. | **Deployment repair.** Restored deploys without disabling scanning of credentials. |
| `2ce7fa4` | Changed duplicate-create guard from `userId + accountId` to account-only and hid Add connection when one exists. | **Lifecycle hardening.** Prevents a stale legacy owner field from opening a duplicate/key-divergence route. |

## What Earlier Commits Did Not Prove

No examined commit shows that the EA itself placed, modified, or closed orders. The current EA source is read-only and has a regression contract banning trade-execution APIs. No examined PWA commit made `/api/*` cacheable; the worker bypasses API responses. No examined authenticated frontend source makes MT5 visibility depend on an unreported session timeout; protected data loads only after the authenticated profile gate and account reconciliation complete.

The static repository audit cannot prove which individual production button was clicked or which one-time key is currently pasted into a trader's desktop terminal. It can prove that replacement/rotation invalidates the prior key and resets contact fields by design. The production UI observed after owner normalization contained an active selected-account connection with no recorded first contact, which is therefore a current-key/contact state rather than the earlier hidden-workspace defect.

## Current Corrected Contract

1. A connection is owned canonically by its journal account.
2. A selected account can see its account-scoped connection even if a legacy copied row originally had stale owner metadata.
3. API-key ingress normalizes legacy owner metadata before it persists summary, open-position, or history events.
4. Retiring a connection retains the record and journal history; deleting an account remains the only cascade path.
5. A replacement key intentionally invalidates the previous key and resets live-contact fields. The plaintext replacement key is displayed once only.
6. A selected account with any connection row cannot create a duplicate connection through the normal UI.
7. The current EA download is generated for the deployment origin, not a fixed stale host.

## Remaining Production Boundary

Migration `0018_mt5_connection_owner_repair.sql` is additive and must be applied in Supabase to make the owner relationship database-enforced for all existing and future rows. The runtime normalization makes the currently deployed code recover a stale connection row upon a valid connection/API-key read, but a database migration is still the durable schema safeguard.
