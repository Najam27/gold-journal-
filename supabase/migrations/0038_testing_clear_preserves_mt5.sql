-- Clearing Testing Lab data must not touch Live MT5 sync bookkeeping.
--
-- gj_clear_account_journal_data reset journalDataResetAt / historySyncedCount
-- unconditionally, even for a TESTING clear. mt5Db.isMt5PositionAfterJournalReset
-- then treats every Live position opened before the reset as pre-reset: open
-- positions stop being upserted and close events are dropped, so the journal
-- row stays OPEN forever. From here the watermark reset only runs on the LIVE
-- (legacy) path; a Testing clear deletes Testing trades and nothing else.
-- Additive and idempotent (create or replace).
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

  if target_environment = 'TESTING' then
    -- Testing clears are scoped to Testing trades only. The MT5 connection
    -- row is an account-level Live concept: its journal-sync bookkeeping must
    -- never be touched from Testing.
    delete from public.gj_trades
     where "userId" = target_user_id
       and "accountId" = target_account_id
       and "environment" = 'TESTING';
  else
    -- LIVE is the legacy path, preserved exactly as it was: clearing the
    -- journal resets the MT5 sync watermarks so post-clear positions sync
    -- fresh, then wipes the account's whole journal.
    update public.gj_mt5_connections
       set "journalDataResetAt" = target_reset_at,
           "historySyncedCount" = 0,
           "lastHistorySync" = null,
           "lastHistoryStatus" = 'RESET',
           "lastHistoryMessage" = 'Journal data was cleared; awaiting post-reset MT5 events.'
     where "userId" = target_user_id and "accountId" = target_account_id;

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
