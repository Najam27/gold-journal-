-- Defense in depth: every account-scoped child must carry the same owner id as its account.
-- Existing rows are not modified; constraint creation fails explicitly if legacy data is inconsistent.
create unique index if not exists "gj_accounts_id_user_unique" on public.gj_accounts ("id", "userId");
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gj_trades_account_owner_fk') then
    alter table public.gj_trades add constraint "gj_trades_account_owner_fk" foreign key ("accountId", "userId") references public.gj_accounts ("id", "userId") on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_cash_account_owner_fk') then
    alter table public.gj_cash_movements add constraint "gj_cash_account_owner_fk" foreign key ("accountId", "userId") references public.gj_accounts ("id", "userId") on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_goals_account_owner_fk') then
    alter table public.gj_goals add constraint "gj_goals_account_owner_fk" foreign key ("accountId", "userId") references public.gj_accounts ("id", "userId") on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_skipped_account_owner_fk') then
    alter table public.gj_skipped_trades add constraint "gj_skipped_account_owner_fk" foreign key ("accountId", "userId") references public.gj_accounts ("id", "userId") on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_daily_plan_account_owner_fk') then
    alter table public.gj_daily_plans add constraint "gj_daily_plan_account_owner_fk" foreign key ("accountId", "userId") references public.gj_accounts ("id", "userId") on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_notification_account_owner_fk') then
    alter table public.gj_notification_history add constraint "gj_notification_account_owner_fk" foreign key ("accountId", "userId") references public.gj_accounts ("id", "userId") on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_connection_account_owner_fk') then
    alter table public.gj_mt5_connections add constraint "gj_mt5_connection_account_owner_fk" foreign key ("accountId", "userId") references public.gj_accounts ("id", "userId") on delete cascade;
  end if;
end;
$$;

create or replace function public.gj_account_trade_summary(
  target_user_id integer,
  target_account_id integer
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
  if not exists (select 1 from public.gj_accounts where "id" = target_account_id and "userId" = target_user_id) then
    raise exception 'account unavailable' using errcode = '42501';
  end if;
  return query
  select
    count(*)::bigint as total_trades,
    count(*) filter (where "result" <> 'OPEN')::bigint as closed_trades,
    count(*) filter (where "result" = 'WIN')::bigint as win_trades,
    count(*) filter (where "result" = 'LOSS')::bigint as loss_trades,
    coalesce(sum("pnl"), 0)::numeric as pnl
  from public.gj_trades
  where "userId" = target_user_id and "accountId" = target_account_id;
end;
$$;

revoke all on function public.gj_account_trade_summary(integer, integer) from public, anon, authenticated;
grant execute on function public.gj_account_trade_summary(integer, integer) to service_role;


create or replace function public.gj_record_goal_alerts(
  target_user_id integer,
  target_account_id integer,
  alerts jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  alert jsonb;
  recorded integer := 0;
  alert_type varchar;
  alert_message text;
  alert_goal_id integer;
begin
  perform 1 from public.gj_accounts
   where "id" = target_account_id and "userId" = target_user_id;
  if not found then
    raise exception 'account unavailable' using errcode = '42501';
  end if;

  if alerts is null or jsonb_typeof(alerts) <> 'array' or jsonb_array_length(alerts) > 20 then
    raise exception 'invalid alert batch' using errcode = '22023';
  end if;

  for alert in select value from jsonb_array_elements(alerts) loop
    alert_goal_id := (alert->>'goalId')::integer;
    alert_type := alert->>'type';
    alert_message := alert->>'message';
    if alert_goal_id is null or alert_type is null or alert_message is null
       or length(alert_type) < 1 or length(alert_type) > 60
       or length(alert_message) < 1 or length(alert_message) > 800 then
      raise exception 'invalid alert item' using errcode = '22023';
    end if;
    if public.gj_record_goal_alert(target_user_id, target_account_id, alert_goal_id, alert_type, alert_message) then
      recorded := recorded + 1;
    end if;
  end loop;
  return recorded;
end;
$$;

revoke all on function public.gj_record_goal_alerts(integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.gj_record_goal_alerts(integer, integer, jsonb) to service_role;
