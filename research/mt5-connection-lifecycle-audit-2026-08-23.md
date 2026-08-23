# MT5 Connection Lifecycle Audit

**Author:** Manus AI  
**Date:** 2026-08-23  
**Scope:** Investigate why an account can retain synchronized MT5 history while MT5 Live reports no connection record.

## Evidence captured before code changes

The supplied production screenshot shows closed MT5 history attached to the selected journal account while the MT5 Live workspace has no returned connection record. The public production workspace was also opened in the authenticated browser without changing data; it presented the same selected-account context and temporarily entered its normal protected-journal loading state.

GitHub’s commits API reports **83 available commits** for `Najam27/gold-journal-`. The local shallow working history contains the current 20-commit branch segment, while the relevant MT5 changes start with the history-batch change (`101269e`) and continue through the current first-contact recovery releases. Therefore, the audit will use GitHub remote history for the complete inventory and local source/diffs for detailed lifecycle analysis.

## Current working hypothesis

`getMt5Workspace()` returns every `gj_mt5_connections` row for the authenticated selected account, without filtering on `active`. Therefore, a workspace with history but an empty `connections` result indicates either a physically removed row, a different account scope, or a failed workspace response; it is not explained by the connection merely being marked inactive. This is a hypothesis to verify against each historical mutation and database constraint before any fix is proposed.

## Commit-by-commit inventory

The full GitHub history contains **83 commits**. Each commit was inventoried chronologically. **35 commits** changed an MT5, connection-lifecycle, router, atomic-operation, schema, or migration file; the remaining **48 commits** did not change an MT5 lifecycle file. The material MT5 evolution was:

| Range | Verified effect on lifecycle |
|---|---|
| `76ae988` through `ed6e530` | Introduced connection persistence, then corrected migration parameter handling. |
| `87ef529` through `c7b8ee7` | Hardened the MT5 HTTP/JSON path and repaired history synchronization and atomic history persistence. |
| `101269e` and `eb45e84` | Added history-batch persistence and live-position-to-Trade-Log persistence. These deliberately make history durable at account scope. |
| `daabab3` and `85682dc` | Added sync health, diagnostics, and lifecycle fields; they do not add a background deletion path. |
| `d1e1b7c` through `a52efc3` | Added reconnect, first-contact and key-rotation recovery UI, but retained the older physical connection deletion operation. |

## Root cause confirmed

The problem is **not** that a connection became inactive. The workspace query returns inactive rows as well. The screenshot’s empty connection list means the row was physically absent for that account.

The audit found one direct application path able to produce that exact state: the original protected `mt5.deleteConnection` procedure performs a physical `DELETE` of `gj_mt5_connections`. The connection table is independent of `gj_mt5_live_positions` and `gj_trades`; therefore a connection row can be deleted while account-scoped historical positions and journal rows stay intact. This produces the observed reverse behavior: history remains visible, but no connection/snapshot exists.

The account-wide clear procedure was separately verified. It **updates** the connection reset metadata and deletes historical journal data; it does not delete the connection row. Account deletion can cascade-delete connections, but it would also remove account-scoped history, which does not match the screenshot.

## Repair direction

The direct delete operation must become a non-destructive **retirement**: invalidate the API key, mark the record inactive/retired, retain audit metadata, and permit a replacement key on the same account-scoped row. Existing orphaned history cannot safely recreate an old key, so the user-facing recovery remains an explicit replacement-key action; however, the system will no longer remove future connection records through its normal MT5 control.
