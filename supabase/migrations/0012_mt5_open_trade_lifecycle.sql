-- Apply after 0011. The existing unique (accountId, mt5Ticket) constraint is the
-- immutable MT5 identity. This migration only extends the authoritative atomic
-- RPC so OPEN events persist the same journal row that a later CLOSE finalizes.

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
  target_status varchar(8) := (position_payload->>'status')::varchar;
  existing_status varchar(8);
  existing_open_time timestamptz;
  effective_open_time timestamptz;
begin
  if target_status not in ('OPEN', 'CLOSED') then
    raise exception 'invalid MT5 position status' using errcode = '22023';
  end if;

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

  -- CLOSED is terminal: delayed polling and history replay cannot reopen or rewrite it.
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
    case when target_status = 'OPEN' then (position_payload->>'floatingPnl')::numeric else 0 end,
    nullif(position_payload->>'realizedPnl', '')::numeric,
    position_payload->>'result', effective_open_time, nullif(position_payload->>'closeTime', '')::timestamptz,
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
    "tpPlacement", "mistake", "holdQuality", "patienceScore", "risk", "reward", "pnl", "openTime", "closeTime", "notes",
    "emotionBefore", "emotionDuring", "emotionAfter", "mt5Ticket"
  ) values (
    target_user_id, target_account_id, (position_payload->>'tradeTime')::timestamptz, position_payload->>'session', position_payload->>'direction', position_payload->>'result',
    '', '', '', '', '', '', '', '', '', '', '', null, (position_payload->>'riskUsd')::numeric, (position_payload->>'rewardUsd')::numeric,
    (position_payload->>'pnl')::numeric, effective_open_time, nullif(position_payload->>'closeTime', '')::timestamptz, '', '', '', '', target_ticket
  )
  on conflict ("accountId", "mt5Ticket") do update set
    "tradeDate" = excluded."tradeDate", "session" = excluded."session", "direction" = excluded."direction",
    "result" = excluded."result", "risk" = excluded."risk", "reward" = excluded."reward", "pnl" = excluded."pnl",
    "openTime" = excluded."openTime", "closeTime" = excluded."closeTime", "updatedAt" = now();

  return true;
end;
$$;

revoke all on function public.gj_sync_mt5_position(integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.gj_sync_mt5_position(integer, integer, jsonb) to service_role;
