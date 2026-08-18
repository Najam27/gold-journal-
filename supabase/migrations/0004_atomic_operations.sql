-- Real PostgreSQL transaction boundaries for multi-write operations.
-- These SECURITY DEFINER functions are callable only by the server service role;
-- application authorization is enforced by the target user/account arguments and
-- the server-side ownership chain before invocation.

create or replace function public.gj_clear_account_journal_data(
  target_user_id integer,
  target_account_id integer,
  target_reset_at timestamptz
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
  return true;
end;
$$;

create or replace function public.gj_remove_account(
  target_user_id integer,
  target_account_id integer
)
returns table(replacement_account_id integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  account_count integer;
  replacement_id integer;
  deleted_id integer;
begin
  select count(*) into account_count
    from public.gj_accounts
   where "userId" = target_user_id;
  if account_count < 2 then
    raise exception 'create another account before removing your only account' using errcode = '23514';
  end if;

  perform 1 from public.gj_accounts
   where "id" = target_account_id and "userId" = target_user_id
   for update;
  if not found then
    raise exception 'account unavailable' using errcode = '42501';
  end if;

  select "id" into replacement_id
    from public.gj_accounts
   where "userId" = target_user_id and "id" <> target_account_id
   order by "id"
   limit 1
   for update;

  delete from public.gj_notification_history where "userId" = target_user_id and "accountId" = target_account_id;
  delete from public.gj_daily_plans where "userId" = target_user_id and "accountId" = target_account_id;
  delete from public.gj_skipped_trades where "userId" = target_user_id and "accountId" = target_account_id;
  delete from public.gj_cash_movements where "userId" = target_user_id and "accountId" = target_account_id;
  delete from public.gj_goals where "userId" = target_user_id and "accountId" = target_account_id;
  delete from public.gj_mt5_live_positions where "accountId" = target_account_id;
  delete from public.gj_mt5_connections where "userId" = target_user_id and "accountId" = target_account_id;
  delete from public.gj_trades where "userId" = target_user_id and "accountId" = target_account_id;

  delete from public.gj_accounts
   where "userId" = target_user_id and "id" = target_account_id
   returning "id" into deleted_id;
  if deleted_id is null then
    raise exception 'account removal did not delete the requested account';
  end if;

  replacement_account_id := replacement_id;
  return next;
end;
$$;

create or replace function public.gj_sync_mt5_position(
  target_user_id integer,
  target_account_id integer,
  position_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target_ticket bigint := (position_payload->>'ticket')::bigint;
  target_status varchar(8) := position_payload->>'status';
  existing_status varchar(8);
  existing_open_time timestamptz;
  effective_open_time timestamptz;
  target_trade_time timestamptz := (position_payload->>'tradeTime')::timestamptz;
  target_result varchar(16) := position_payload->>'result';
begin
  perform 1 from public.gj_accounts
   where "id" = target_account_id and "userId" = target_user_id
   for update;
  if not found then
    raise exception 'account unavailable' using errcode = '42501';
  end if;

  select "status", "openTime" into existing_status, existing_open_time
    from public.gj_mt5_live_positions
   where "accountId" = target_account_id and "ticket" = target_ticket
   for update;

  if existing_status = 'CLOSED' then
    return false;
  end if;
  effective_open_time := coalesce(existing_open_time, (position_payload->>'openTime')::timestamptz);

  insert into public.gj_mt5_live_positions (
    "accountId", "ticket", "symbol", "direction", "lots", "openPrice", "closePrice",
    "slPrice", "tpPrice", "riskUsd", "rewardUsd", "rrRatio", "floatingPnl",
    "realizedPnl", "result", "openTime", "closeTime", "status", "updatedAt"
  ) values (
    target_account_id, target_ticket, position_payload->>'symbol', position_payload->>'direction',
    (position_payload->>'lots')::numeric, (position_payload->>'openPrice')::numeric, nullif(position_payload->>'closePrice', '')::numeric,
    nullif(position_payload->>'slPrice', '')::numeric, nullif(position_payload->>'tpPrice', '')::numeric,
    (position_payload->>'riskUsd')::numeric, (position_payload->>'rewardUsd')::numeric, (position_payload->>'rrRatio')::numeric,
    (position_payload->>'floatingPnl')::numeric, nullif(position_payload->>'realizedPnl', '')::numeric,
    target_result, effective_open_time, nullif(position_payload->>'closeTime', '')::timestamptz,
    target_status, now()
  )
  on conflict ("accountId", "ticket") do update set
    "symbol" = excluded."symbol", "direction" = excluded."direction", "lots" = excluded."lots",
    "openPrice" = excluded."openPrice", "closePrice" = excluded."closePrice", "slPrice" = excluded."slPrice",
    "tpPrice" = excluded."tpPrice", "riskUsd" = excluded."riskUsd", "rewardUsd" = excluded."rewardUsd",
    "rrRatio" = excluded."rrRatio", "floatingPnl" = excluded."floatingPnl", "realizedPnl" = excluded."realizedPnl",
    "result" = excluded."result", "openTime" = excluded."openTime", "closeTime" = excluded."closeTime",
    "status" = excluded."status", "updatedAt" = now();

  insert into public.gj_trades (
    "userId", "accountId", "tradeDate", "session", "direction", "result", "level", "timeframe",
    "setupQuality", "executionType", "marketCondition", "biasAlignment", "confirmationType", "slPlacement",
    "tpPlacement", "mistake", "holdQuality", "patienceScore", "risk", "reward", "pnl", "notes",
    "emotionBefore", "emotionDuring", "emotionAfter", "mt5Ticket"
  ) values (
    target_user_id, target_account_id, target_trade_time, position_payload->>'session', position_payload->>'direction', target_result,
    '', '', '', '', '', '', '', '', '', '', '', null, (position_payload->>'riskUsd')::numeric, (position_payload->>'rewardUsd')::numeric,
    (position_payload->>'pnl')::numeric, '', '', '', '', target_ticket
  )
  on conflict ("accountId", "mt5Ticket") do update set
    "tradeDate" = excluded."tradeDate", "session" = excluded."session", "direction" = excluded."direction",
    "result" = excluded."result", "risk" = excluded."risk", "reward" = excluded."reward",
    "pnl" = excluded."pnl", "updatedAt" = now();

  return true;
end;
$$;

revoke all on function public.gj_clear_account_journal_data(integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.gj_remove_account(integer, integer) from public, anon, authenticated;
revoke all on function public.gj_sync_mt5_position(integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.gj_clear_account_journal_data(integer, integer, timestamptz) to service_role;
grant execute on function public.gj_remove_account(integer, integer) to service_role;
grant execute on function public.gj_sync_mt5_position(integer, integer, jsonb) to service_role;


create or replace function public.gj_record_goal_alert(
  target_user_id integer,
  target_account_id integer,
  target_goal_id integer,
  target_type varchar,
  target_message text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.gj_accounts
   where "id" = target_account_id and "userId" = target_user_id;
  if not found then
    raise exception 'account unavailable' using errcode = '42501';
  end if;

  perform 1 from public.gj_goals
   where "id" = target_goal_id and "userId" = target_user_id
     and "accountId" = target_account_id and "active" = true and "notify" = true;
  if not found then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text || ':' || target_type, 0));
  if exists (select 1 from public.gj_notification_history where "userId" = target_user_id and "type" = target_type) then
    return false;
  end if;

  insert into public.gj_notification_history ("userId", "accountId", "type", "message")
  values (target_user_id, target_account_id, target_type, target_message);
  return true;
end;
$$;

revoke all on function public.gj_record_goal_alert(integer, integer, integer, varchar, text) from public, anon, authenticated;
grant execute on function public.gj_record_goal_alert(integer, integer, integer, varchar, text) to service_role;
