-- Testing Mode: the trade log is reused under an environment discriminator so
-- forward-testing trades live alongside, but never mix with, live trades.
--
-- - `environment` ('LIVE' | 'TESTING') marks every trade row. The default fills
--   existing rows as LIVE at ADD COLUMN time, so no live record can ever become
--   Testing and no migration-time backfill can race with writes.
-- - `exitPrice` gives Testing trades the exit leg needed for pips math.
--   (Live trades never needed an exit price: their P&L is recorded in dollars.)
-- - `gj_clear_account_journal_data` gains a `target_environment` parameter:
--   'TESTING' deletes only Testing trades (the other journal tables are
--   account-level Live concepts and stay untouched), while the 'LIVE' default
--   runs the exact legacy clear for every existing caller.
-- - `gj_account_trade_summary` gains the same parameter so the Trade Log stats
--   never blend dollars with pips.
-- Both RPCs keep backward-compatible signatures: `target_environment` defaults
-- to 'LIVE', so every existing caller gets exactly its old result set.
-- Additive and idempotent.

alter table public.gj_trades
  add column if not exists "environment" varchar(8) not null default 'LIVE';

alter table public.gj_trades
  add column if not exists "exitPrice" numeric(18, 6);

-- Belt and braces: the NOT NULL DEFAULT already backfilled, but a column added
-- by an older half-applied migration could theoretically hold NULLs.
update public.gj_trades set "environment" = 'LIVE' where "environment" is null;

create index if not exists "gj_trades_owner_account_environment_idx"
  on public.gj_trades ("userId", "accountId", "environment");

create or replace function public.gj_account_trade_summary(
  target_user_id integer,
  target_account_id integer,
  target_environment varchar(8) default 'LIVE'
)
returns table (
  total_trades bigint,
  closed_trades bigint,
  win_trades bigint,
  loss_trades bigint,
  pnl numeric
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.gj_accounts as account where account."id" = target_account_id and account."userId" = target_user_id) then
    raise exception 'account unavailable' using errcode = '42501';
  end if;
  return query
  select
    count(*)::bigint as total_trades,
    count(*) filter (where trade."result" <> 'OPEN')::bigint as closed_trades,
    count(*) filter (where trade."result" = 'WIN')::bigint as win_trades,
    count(*) filter (where trade."result" = 'LOSS')::bigint as loss_trades,
    coalesce(sum(trade."pnl"), 0)::numeric as pnl
  from public.gj_trades as trade
  where trade."userId" = target_user_id
    and trade."accountId" = target_account_id
    and trade."environment" = target_environment;
end;
$$;

revoke all on function public.gj_account_trade_summary(integer, integer) from public, anon, authenticated;
revoke all on function public.gj_account_trade_summary(integer, integer, varchar) from public, anon, authenticated;
grant execute on function public.gj_account_trade_summary(integer, integer) to service_role;
grant execute on function public.gj_account_trade_summary(integer, integer, varchar) to service_role;

create or replace function public.gj_clear_account_journal_data(
  target_user_id integer,
  target_account_id integer,
  target_reset_at timestamptz,
  target_environment varchar(8) default 'LIVE'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.gj_accounts
   where "id" = target_account_id and "userId" = target_user_id
   for update;
  if not found then
    raise exception 'account unavailable' using errcode = '42501';
  end if;

  -- The MT5 connection row is account-level, not trade-level: clearing either
  -- environment resets its journal-sync bookkeeping the same as before.
  update public.gj_mt5_connections
     set "journalDataResetAt" = target_reset_at,
         "historySyncedCount" = 0,
         "lastHistorySync" = null,
         "lastHistoryStatus" = 'RESET',
         "lastHistoryMessage" = 'Journal data was cleared; awaiting post-reset MT5 events.'
   where "userId" = target_user_id and "accountId" = target_account_id;

  if target_environment = 'TESTING' then
    -- Testing clears are scoped to Testing trades only. The other journal
    -- tables (cash, plans, skipped trades, notifications, MT5 positions) are
    -- account-level Live concepts and must never be touched from Testing.
    delete from public.gj_trades
     where "userId" = target_user_id
       and "accountId" = target_account_id
       and "environment" = 'TESTING';
  else
    -- LIVE is the legacy path, preserved exactly as it was: the account's
    -- whole journal is wiped, trades included.
    delete from public.gj_notification_history where "userId" = target_user_id and "accountId" = target_account_id;
    delete from public.gj_daily_plans where "userId" = target_user_id and "accountId" = target_account_id;
    delete from public.gj_skipped_trades where "userId" = target_user_id and "accountId" = target_account_id;
    delete from public.gj_cash_movements where "userId" = target_user_id and "accountId" = target_account_id;
    delete from public.gj_mt5_live_positions where "accountId" = target_account_id;
    delete from public.gj_trades where "userId" = target_user_id and "accountId" = target_account_id;
  end if;
  return true;
end;
$$;

revoke all on function public.gj_clear_account_journal_data(integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.gj_clear_account_journal_data(integer, integer, timestamptz, varchar) from public, anon, authenticated;
grant execute on function public.gj_clear_account_journal_data(integer, integer, timestamptz) to service_role;
grant execute on function public.gj_clear_account_journal_data(integer, integer, timestamptz, varchar) to service_role;
