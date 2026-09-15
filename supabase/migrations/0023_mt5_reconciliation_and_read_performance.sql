-- Apply after 0022. Additive performance migration for the paths audited while
-- fixing the account-switch / Trade Log timeout.
--
-- Why: the timeout was NOT a missing index on its own, but the read paths were
-- doing write work (MT5 -> Trade Log reconciliation, one HTTP round-trip per
-- stored position) and the reconciliation read itself had no index it could use:
--
--   select * from gj_mt5_live_positions
--    where "accountId" = $1
--    order by "updatedAt" desc
--    limit 500;
--
-- The only existing index on that table is ("accountId", "status", "updatedAt").
-- A leading equality on "accountId" followed by an ORDER BY on the THIRD column
-- cannot be satisfied by that index (the unconstrained "status" column sits in
-- between), so the planner had to sort the account's whole position history for
-- every reconciliation pass. The new index makes that read index-ordered.
--
-- This migration only adds indexes and refreshes planner statistics. It does not
-- change a column, a row, a constraint, an RPC, or any P&L value, and it is safe
-- to run on a live database.

-- 1. MT5 reconciliation read (bounded passes over stored positions) ------------
create index if not exists gj_mt5_live_positions_account_updated_idx
  on public.gj_mt5_live_positions ("accountId", "updatedAt" desc);

-- 2. Trade Log page: filter, order, and the matching count --------------------
-- trades.list reads `userId + accountId [+ result] order by tradeDate desc, id desc
-- limit N offset M` and counts the same predicate. The (userId, accountId,
-- tradeDate) index already existed; adding the descending id tiebreaker lets the
-- planner satisfy the full ORDER BY from the index, so paging a long history no
-- longer sorts (and re-sorts for the count) on every poll.
create index if not exists gj_trades_owner_account_date_id_idx
  on public.gj_trades ("userId", "accountId", "tradeDate" desc, "id" desc);

-- 3. Journal composite read: the 45-day goal window --------------------------
-- getJournal reads trades inside a rolling 45-day window for the goal engine:
-- `userId = $1 and accountId = $2 and tradeDate >= $3 order by tradeDate desc`.
-- The descending variant serves that range scan and its ordering directly.
create index if not exists gj_trades_owner_account_date_desc_idx
  on public.gj_trades ("userId", "accountId", "tradeDate" desc);

-- 4. MT5 ingest: connection lookup by key fingerprint ------------------------
-- getActiveMt5Connection authenticates every EA request with
-- `apiKey = $1 and active and "retiredAt" is null`. The unique index on apiKey
-- resolves it, but the active/retired predicate is not covered; this partial
-- index keeps the hottest write path (open_batch every few seconds per terminal)
-- an index-only qualification.
create index if not exists gj_mt5_connection_active_key_idx
  on public.gj_mt5_connections ("apiKey")
  where active and "retiredAt" is null;

-- 5. Planner statistics ------------------------------------------------------
-- New indexes are only used once the planner has current statistics; a live
-- database may otherwise keep its previous plan until autovacuum runs.
analyze public.gj_mt5_live_positions;
analyze public.gj_trades;
analyze public.gj_mt5_connections;

-- 6. Verification (run these by hand against production) ---------------------
-- The two aggregates behind the journal balance and summary must not scan the
-- account's whole trade history. Confirm each one reports an Index Scan / Index
-- Only Scan on a gj_trades index and a row estimate close to the account size:
--
--   explain (analyze, buffers)
--   select * from public.gj_account_cash_net(target_user_id => 1, target_account_id => 1);
--
--   explain (analyze, buffers)
--   select * from public.gj_account_trade_summary(target_user_id => 1, target_account_id => 1);
--
--   explain (analyze, buffers)
--   select * from public.gj_trades
--    where "userId" = 1 and "accountId" = 1
--    order by "tradeDate" desc, "id" desc
--    limit 12 offset 0;
--
--   explain (analyze, buffers)
--   select * from public.gj_mt5_live_positions
--    where "accountId" = 1
--    order by "updatedAt" desc
--    limit 500;
--
-- Anything reporting a Sequential Scan, a Sort, or a row estimate far above the
-- real account size is a remaining bottleneck; report it with the [PERF] stage
-- line from the server log for the matching request.
