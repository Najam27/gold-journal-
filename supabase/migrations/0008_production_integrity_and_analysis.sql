-- Gold Journal production integrity and analysis data contract.
-- Apply after 0001 through 0007. This migration is additive and idempotent.

-- Analysis fields are stored as UTC instants/numeric excursions. PKT is derived at analysis time.
alter table public.gj_trades add column if not exists "openTime" timestamptz;
alter table public.gj_trades add column if not exists "closeTime" timestamptz;
alter table public.gj_trades add column if not exists "mfe" numeric(14,2);
alter table public.gj_trades add column if not exists "mae" numeric(14,2);
create index if not exists gj_trades_owner_account_close_idx on public.gj_trades("userId", "accountId", "closeTime" desc, "id" desc);
create index if not exists gj_trades_owner_account_result_date_idx on public.gj_trades("userId", "accountId", "result", "tradeDate" desc, "id" desc);

-- Every account-scoped row must agree with the owner of its referenced account.
do $$
begin
  if exists (select 1 from public.gj_trades t join public.gj_accounts a on a."id" = t."accountId" where t."userId" <> a."userId")
    or exists (select 1 from public.gj_cash_movements t join public.gj_accounts a on a."id" = t."accountId" where t."userId" <> a."userId")
    or exists (select 1 from public.gj_goals t join public.gj_accounts a on a."id" = t."accountId" where t."userId" <> a."userId")
    or exists (select 1 from public.gj_skipped_trades t join public.gj_accounts a on a."id" = t."accountId" where t."userId" <> a."userId")
    or exists (select 1 from public.gj_daily_plans t join public.gj_accounts a on a."id" = t."accountId" where t."userId" <> a."userId")
    or exists (select 1 from public.gj_notification_history t join public.gj_accounts a on a."id" = t."accountId" where t."accountId" is not null and t."userId" <> a."userId")
    or exists (select 1 from public.gj_mt5_connections t join public.gj_accounts a on a."id" = t."accountId" where t."userId" <> a."userId") then
    raise exception 'account ownership mismatch exists; repair data before applying 0008' using errcode = '23514';
  end if;
end;
$$;

create unique index if not exists gj_accounts_id_user_unique on public.gj_accounts("id", "userId");

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gj_trades_account_owner_fk') then
    alter table public.gj_trades add constraint gj_trades_account_owner_fk foreign key ("accountId", "userId") references public.gj_accounts("id", "userId") on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_cash_account_owner_fk') then
    alter table public.gj_cash_movements add constraint gj_cash_account_owner_fk foreign key ("accountId", "userId") references public.gj_accounts("id", "userId") on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_goals_account_owner_fk') then
    alter table public.gj_goals add constraint gj_goals_account_owner_fk foreign key ("accountId", "userId") references public.gj_accounts("id", "userId") on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_skipped_account_owner_fk') then
    alter table public.gj_skipped_trades add constraint gj_skipped_account_owner_fk foreign key ("accountId", "userId") references public.gj_accounts("id", "userId") on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_daily_plan_account_owner_fk') then
    alter table public.gj_daily_plans add constraint gj_daily_plan_account_owner_fk foreign key ("accountId", "userId") references public.gj_accounts("id", "userId") on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_notification_account_owner_fk') then
    alter table public.gj_notification_history add constraint gj_notification_account_owner_fk foreign key ("accountId", "userId") references public.gj_accounts("id", "userId") on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_connection_account_owner_fk') then
    alter table public.gj_mt5_connections add constraint gj_mt5_connection_account_owner_fk foreign key ("accountId", "userId") references public.gj_accounts("id", "userId") on delete cascade not valid;
  end if;
end;
$$;

alter table public.gj_trades validate constraint gj_trades_account_owner_fk;
alter table public.gj_cash_movements validate constraint gj_cash_account_owner_fk;
alter table public.gj_goals validate constraint gj_goals_account_owner_fk;
alter table public.gj_skipped_trades validate constraint gj_skipped_account_owner_fk;
alter table public.gj_daily_plans validate constraint gj_daily_plan_account_owner_fk;
alter table public.gj_notification_history validate constraint gj_notification_account_owner_fk;
alter table public.gj_mt5_connections validate constraint gj_mt5_connection_account_owner_fk;

-- Serialize account removal per user before counting, so two concurrent removals cannot
-- both observe two accounts and leave the user with zero accounts.
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
  perform 1 from public.users where "id" = target_user_id for update;
  if not found then
    raise exception 'user unavailable' using errcode = '42501';
  end if;

  select count(*) into account_count from public.gj_accounts where "userId" = target_user_id;
  if account_count < 2 then
    raise exception 'create another account before removing your only account' using errcode = '23514';
  end if;

  perform 1 from public.gj_accounts where "id" = target_account_id and "userId" = target_user_id for update;
  if not found then
    raise exception 'account unavailable' using errcode = '42501';
  end if;

  select "id" into replacement_id from public.gj_accounts where "userId" = target_user_id and "id" <> target_account_id order by "id" limit 1;

  delete from public.gj_accounts where "userId" = target_user_id and "id" = target_account_id returning "id" into deleted_id;
  if deleted_id is null then
    raise exception 'account removal did not delete the requested account';
  end if;

  replacement_account_id := replacement_id;
  return next;
end;
$$;

revoke all on function public.gj_remove_account(integer, integer) from public, anon, authenticated;
grant execute on function public.gj_remove_account(integer, integer) to service_role;

-- Replace the historical sync function so live floating P&L is never mirrored into
-- realized journal trades. Only a CLOSED event creates/updates a journal trade row.
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
begin
  perform 1 from public.gj_accounts where "id" = target_account_id and "userId" = target_user_id for update;
  if not found then
    raise exception 'account unavailable' using errcode = '42501';
  end if;

  select "status", "openTime" into existing_status, existing_open_time
    from public.gj_mt5_live_positions
   where "accountId" = target_account_id and "ticket" = target_ticket
   for update;

  -- A CLOSED row is terminal. Late/replayed OPEN or CLOSE events cannot reopen it.
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

  if target_status = 'CLOSED' then
    insert into public.gj_trades (
      "userId", "accountId", "tradeDate", "session", "direction", "result", "level", "timeframe",
      "setupQuality", "executionType", "marketCondition", "biasAlignment", "confirmationType", "slPlacement",
      "tpPlacement", "mistake", "holdQuality", "patienceScore", "risk", "reward", "pnl", "openTime", "closeTime", "notes",
      "emotionBefore", "emotionDuring", "emotionAfter", "mt5Ticket"
    ) values (
      target_user_id, target_account_id, (position_payload->>'tradeTime')::timestamptz, position_payload->>'session', position_payload->>'direction', position_payload->>'result',
      '', '', '', '', '', '', '', '', '', '', null, (position_payload->>'riskUsd')::numeric, (position_payload->>'rewardUsd')::numeric,
      (position_payload->>'pnl')::numeric, effective_open_time, nullif(position_payload->>'closeTime', '')::timestamptz, '', '', '', '', target_ticket
    )
    on conflict ("accountId", "mt5Ticket") do update set
      "tradeDate" = excluded."tradeDate", "session" = excluded."session", "direction" = excluded."direction",
      "result" = excluded."result", "risk" = excluded."risk", "reward" = excluded."reward", "pnl" = excluded."pnl",
      "openTime" = excluded."openTime", "closeTime" = excluded."closeTime", "updatedAt" = now();
  end if;
  return true;
end;
$$;

revoke all on function public.gj_sync_mt5_position(integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.gj_sync_mt5_position(integer, integer, jsonb) to service_role;

-- Distributed rate limiter for serverless instances. The row lock makes the
-- increment-and-check operation atomic per scope and identity hash.
create table if not exists public.gj_rate_limit_buckets (
  "scope" varchar(80) not null,
  "identityHash" varchar(128) not null,
  "windowStartedAt" timestamptz not null,
  "count" integer not null default 0,
  "updatedAt" timestamptz not null default now(),
  constraint gj_rate_limit_buckets_pk primary key ("scope", "identityHash")
);
revoke all on table public.gj_rate_limit_buckets from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_rate_limit_buckets to service_role;

create or replace function public.gj_consume_rate_limit(
  target_scope varchar,
  target_identity_hash varchar,
  target_limit integer,
  target_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  bucket public.gj_rate_limit_buckets;
  current_window timestamptz := now();
begin
  if target_limit < 1 or target_window_seconds < 1 then return false; end if;
  insert into public.gj_rate_limit_buckets ("scope", "identityHash", "windowStartedAt", "count", "updatedAt")
  values (target_scope, target_identity_hash, current_window, 1, current_window)
  on conflict ("scope", "identityHash") do update set
    "windowStartedAt" = case when public.gj_rate_limit_buckets."windowStartedAt" <= current_window - make_interval(secs => target_window_seconds) then current_window else public.gj_rate_limit_buckets."windowStartedAt" end,
    "count" = case when public.gj_rate_limit_buckets."windowStartedAt" <= current_window - make_interval(secs => target_window_seconds) then 1 else public.gj_rate_limit_buckets."count" + 1 end,
    "updatedAt" = current_window
  returning * into bucket;
  return bucket."count" <= target_limit;
end;
$$;

revoke all on function public.gj_consume_rate_limit(varchar, varchar, integer, integer) from public, anon, authenticated;
grant execute on function public.gj_consume_rate_limit(varchar, varchar, integer, integer) to service_role;
