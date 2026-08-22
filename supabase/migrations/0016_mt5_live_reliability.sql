-- MT5 Live reliability hardening. This additive migration keeps historical positions and
-- Trade Log rows intact while separating event contact, successful live writes, and failures.

alter table public.gj_mt5_connections add column if not exists "lastContactAt" timestamptz;
alter table public.gj_mt5_connections add column if not exists "lastSummaryAt" timestamptz;
alter table public.gj_mt5_connections add column if not exists "lastSummarySuccessAt" timestamptz;
alter table public.gj_mt5_connections add column if not exists "lastSummaryErrorAt" timestamptz;
alter table public.gj_mt5_connections add column if not exists "lastOpenSyncAt" timestamptz;
alter table public.gj_mt5_connections add column if not exists "lastOpenSyncSuccessAt" timestamptz;
alter table public.gj_mt5_connections add column if not exists "lastOpenSyncErrorAt" timestamptz;
alter table public.gj_mt5_connections add column if not exists "lastErrorAt" timestamptz;
alter table public.gj_mt5_connections add column if not exists "lastErrorCode" varchar(64);
alter table public.gj_mt5_connections add column if not exists "lastErrorMessage" varchar(255);
alter table public.gj_mt5_connections add column if not exists "consecutiveFailures" integer not null default 0;

update public.gj_mt5_connections
set "lastContactAt" = coalesce("lastContactAt", "lastPing"),
    "lastSummarySuccessAt" = coalesce("lastSummarySuccessAt", case when "balance" is not null then "lastPing" else null end)
where "lastContactAt" is null or "lastSummarySuccessAt" is null;

alter table public.gj_mt5_connections drop constraint if exists gj_mt5_failure_count_nonnegative;
alter table public.gj_mt5_connections add constraint gj_mt5_failure_count_nonnegative check ("consecutiveFailures" >= 0);
create index if not exists gj_mt5_connection_health_idx on public.gj_mt5_connections ("accountId", active, "lastContactAt");

create or replace function public.gj_record_mt5_event_failure(
  target_connection_id integer,
  target_operation varchar,
  target_error_code varchar,
  target_error_message varchar
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_code varchar(64) := left(coalesce(target_error_code, 'MT5_SYNC_FAILED'), 64);
  safe_message varchar(255) := left(regexp_replace(coalesce(target_error_message, 'MT5 event update failed.'), '[\r\n]+', ' ', 'g'), 255);
begin
  if target_operation not in ('summary', 'open_batch', 'history_batch') then
    raise exception 'invalid MT5 event operation' using errcode = '22023';
  end if;

  update public.gj_mt5_connections
     set "lastErrorAt" = now(),
         "lastErrorCode" = safe_code,
         "lastErrorMessage" = safe_message,
         "consecutiveFailures" = "consecutiveFailures" + 1,
         "lastSummaryAt" = case when target_operation = 'summary' then now() else "lastSummaryAt" end,
         "lastSummaryErrorAt" = case when target_operation = 'summary' then now() else "lastSummaryErrorAt" end,
         "lastOpenSyncAt" = case when target_operation = 'open_batch' then now() else "lastOpenSyncAt" end,
         "lastOpenSyncErrorAt" = case when target_operation = 'open_batch' then now() else "lastOpenSyncErrorAt" end,
         "lastHistoryAttempt" = case when target_operation = 'history_batch' then now() else "lastHistoryAttempt" end,
         "lastHistoryStatus" = case when target_operation = 'history_batch' then 'FAILED' else "lastHistoryStatus" end,
         "lastHistoryMessage" = case when target_operation = 'history_batch' then left(safe_code || ': ' || safe_message, 255) else "lastHistoryMessage" end,
         "updatedAt" = now()
   where "id" = target_connection_id;
  return found;
end;
$$;

revoke all on function public.gj_record_mt5_event_failure(integer, varchar, varchar, varchar) from public, anon, authenticated;
grant execute on function public.gj_record_mt5_event_failure(integer, varchar, varchar, varchar) to service_role;

create or replace function public.gj_sync_mt5_open_batch(
  target_user_id integer,
  target_account_id integer,
  position_payloads jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  position_payload jsonb;
  synchronized integer := 0;
begin
  if jsonb_typeof(position_payloads) <> 'array' or jsonb_array_length(position_payloads) > 200 then
    raise exception 'invalid MT5 open position batch' using errcode = '22023';
  end if;

  perform 1 from public.gj_accounts
   where "id" = target_account_id and "userId" = target_user_id
   for update;
  if not found then
    raise exception 'account unavailable' using errcode = '42501';
  end if;

  for position_payload in select value from jsonb_array_elements(position_payloads)
  loop
    if coalesce(position_payload->>'status', '') <> 'OPEN' then
      raise exception 'open batch contains a non-OPEN position' using errcode = '22023';
    end if;
    if public.gj_sync_mt5_position(target_user_id, target_account_id, position_payload) then
      synchronized := synchronized + 1;
    end if;
  end loop;

  return synchronized;
end;
$$;

revoke all on function public.gj_sync_mt5_open_batch(integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.gj_sync_mt5_open_batch(integer, integer, jsonb) to service_role;
