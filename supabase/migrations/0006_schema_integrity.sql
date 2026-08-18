-- Gold Journal schema-integrity hardening.
-- Apply after 0001 through 0005. This migration does not rewrite production data.
-- The preflight fails before adding constraints if existing rows violate a confirmed invariant.

revoke all on function public.current_journal_user_id() from public, anon;
revoke all on function public.journal_user_is(integer) from public, anon;
revoke all on function public.owns_journal_account(integer) from public, anon;
revoke all on function public.owns_screenshot_folder(text) from public, anon;
grant execute on function public.current_journal_user_id() to authenticated, service_role;
grant execute on function public.journal_user_is(integer) to authenticated, service_role;
grant execute on function public.owns_journal_account(integer) to authenticated, service_role;
grant execute on function public.owns_screenshot_folder(text) to authenticated, service_role;

do $$
begin
  if exists (select 1 from public.users where "role" not in ('user', 'admin'))
    or exists (select 1 from public.gj_notification_history group by "userId", "type" having count(*) > 1)
    or exists (select 1 from public.gj_accounts where "startingBalance" < 0)
    or exists (select 1 from public.gj_trades where "direction" not in ('BUY', 'SELL') or "result" not in ('WIN', 'LOSS', 'BREAK_EVEN', 'OPEN') or ("patienceScore" is not null and ("patienceScore" < 1 or "patienceScore" > 5)) or ("risk" is not null and "risk" < 0) or ("reward" is not null and "reward" < 0))
    or exists (select 1 from public.gj_cash_movements where "type" not in ('DEPOSIT', 'WITHDRAW') or "amount" <= 0)
    or exists (select 1 from public.gj_goals where "period" not in ('DAILY', 'WEEKLY', 'MONTHLY') or "comparison" not in ('GTE', 'LTE'))
    or exists (select 1 from public.gj_skipped_trades where "direction" not in ('BUY', 'SELL') or "confidence" < 1 or "confidence" > 5)
    or exists (select 1 from public.gj_daily_plans where ("maxTrades" is not null and "maxTrades" < 1) or ("executionScore" is not null and ("executionScore" < 1 or "executionScore" > 5)) or ("overallRating" is not null and ("overallRating" < 1 or "overallRating" > 5)))
    or exists (select 1 from public.gj_mt5_connections where "brokerUtcOffsetMinutes" < -720 or "brokerUtcOffsetMinutes" > 840 or "historySyncedCount" < 0 or ("lastHistoryBatchSize" is not null and ("lastHistoryBatchSize" < 0 or "lastHistoryBatchSize" > 50)))
    or exists (select 1 from public.gj_mt5_live_positions where "ticket" < 0 or "direction" not in ('BUY', 'SELL') or "status" not in ('OPEN', 'CLOSED') or "lots" < 0 or "riskUsd" < 0 or "rewardUsd" < 0 or "rrRatio" < 0 or ("result" is not null and "result" not in ('WIN', 'LOSS', 'BREAK_EVEN', 'OPEN')) or ("status" = 'CLOSED' and ("closePrice" is null or "closeTime" is null or "realizedPnl" is null or "result" is null))) then
    raise exception 'existing data violates schema integrity checks' using errcode = '23514';
  end if;
end;
$$;

create unique index if not exists "gj_notification_user_type_unique" on public.gj_notification_history ("userId", "type");
create index if not exists "gj_accounts_user_created_idx" on public.gj_accounts ("userId", "createdAt" desc);
create index if not exists "gj_cash_owner_account_date_idx" on public.gj_cash_movements ("userId", "accountId", "movementDate" desc);
create index if not exists "gj_goals_owner_account_period_idx" on public.gj_goals ("userId", "accountId", "isCustom", "period", "createdAt");
create index if not exists "gj_skipped_owner_account_date_idx" on public.gj_skipped_trades ("userId", "accountId", "tradeDate" desc);
create index if not exists "gj_daily_plan_owner_account_date_idx" on public.gj_daily_plans ("userId", "accountId", "planDate" desc);
create index if not exists "gj_mt5_live_account_status_close_idx" on public.gj_mt5_live_positions ("accountId", "status", "closeTime" desc);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gj_users_role_valid') then
    alter table public.users add constraint gj_users_role_valid check ("role" in ('user', 'admin'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_accounts_starting_balance_nonnegative') then
    alter table public.gj_accounts add constraint gj_accounts_starting_balance_nonnegative check ("startingBalance" >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_trades_direction_valid') then
    alter table public.gj_trades add constraint gj_trades_direction_valid check ("direction" in ('BUY', 'SELL'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_trades_result_valid') then
    alter table public.gj_trades add constraint gj_trades_result_valid check ("result" in ('WIN', 'LOSS', 'BREAK_EVEN', 'OPEN'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_trades_patience_score_valid') then
    alter table public.gj_trades add constraint gj_trades_patience_score_valid check ("patienceScore" is null or "patienceScore" between 1 and 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_trades_risk_nonnegative') then
    alter table public.gj_trades add constraint gj_trades_risk_nonnegative check ("risk" is null or "risk" >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_trades_reward_nonnegative') then
    alter table public.gj_trades add constraint gj_trades_reward_nonnegative check ("reward" is null or "reward" >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_cash_type_valid') then
    alter table public.gj_cash_movements add constraint gj_cash_type_valid check ("type" in ('DEPOSIT', 'WITHDRAW'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_cash_amount_positive') then
    alter table public.gj_cash_movements add constraint gj_cash_amount_positive check ("amount" > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_goals_period_valid') then
    alter table public.gj_goals add constraint gj_goals_period_valid check ("period" in ('DAILY', 'WEEKLY', 'MONTHLY'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_goals_comparison_valid') then
    alter table public.gj_goals add constraint gj_goals_comparison_valid check ("comparison" in ('GTE', 'LTE'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_skipped_direction_valid') then
    alter table public.gj_skipped_trades add constraint gj_skipped_direction_valid check ("direction" in ('BUY', 'SELL'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_skipped_confidence_valid') then
    alter table public.gj_skipped_trades add constraint gj_skipped_confidence_valid check ("confidence" between 1 and 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_daily_plan_max_trades_valid') then
    alter table public.gj_daily_plans add constraint gj_daily_plan_max_trades_valid check ("maxTrades" is null or "maxTrades" >= 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_daily_plan_execution_score_valid') then
    alter table public.gj_daily_plans add constraint gj_daily_plan_execution_score_valid check ("executionScore" is null or "executionScore" between 1 and 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_daily_plan_overall_rating_valid') then
    alter table public.gj_daily_plans add constraint gj_daily_plan_overall_rating_valid check ("overallRating" is null or "overallRating" between 1 and 5);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_offset_valid') then
    alter table public.gj_mt5_connections add constraint gj_mt5_offset_valid check ("brokerUtcOffsetMinutes" between -720 and 840);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_history_count_nonnegative') then
    alter table public.gj_mt5_connections add constraint gj_mt5_history_count_nonnegative check ("historySyncedCount" >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_history_batch_valid') then
    alter table public.gj_mt5_connections add constraint gj_mt5_history_batch_valid check ("lastHistoryBatchSize" is null or "lastHistoryBatchSize" between 0 and 50);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_position_ticket_nonnegative') then
    alter table public.gj_mt5_live_positions add constraint gj_mt5_position_ticket_nonnegative check ("ticket" >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_position_direction_valid') then
    alter table public.gj_mt5_live_positions add constraint gj_mt5_position_direction_valid check ("direction" in ('BUY', 'SELL'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_position_status_valid') then
    alter table public.gj_mt5_live_positions add constraint gj_mt5_position_status_valid check ("status" in ('OPEN', 'CLOSED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_position_lots_nonnegative') then
    alter table public.gj_mt5_live_positions add constraint gj_mt5_position_lots_nonnegative check ("lots" >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_position_risk_nonnegative') then
    alter table public.gj_mt5_live_positions add constraint gj_mt5_position_risk_nonnegative check ("riskUsd" >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_position_reward_nonnegative') then
    alter table public.gj_mt5_live_positions add constraint gj_mt5_position_reward_nonnegative check ("rewardUsd" >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_position_rr_nonnegative') then
    alter table public.gj_mt5_live_positions add constraint gj_mt5_position_rr_nonnegative check ("rrRatio" >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_position_result_valid') then
    alter table public.gj_mt5_live_positions add constraint gj_mt5_position_result_valid check ("result" is null or "result" in ('WIN', 'LOSS', 'BREAK_EVEN', 'OPEN'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'gj_mt5_closed_position_complete') then
    alter table public.gj_mt5_live_positions add constraint gj_mt5_closed_position_complete check ("status" <> 'CLOSED' or ("closePrice" is not null and "closeTime" is not null and "realizedPnl" is not null and "result" is not null));
  end if;
end;
$$;

create or replace function public.gj_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new."updatedAt" := now();
  return new;
end;
$$;

drop trigger if exists gj_users_updated_at on public.users;
create trigger gj_users_updated_at before update on public.users for each row execute function public.gj_set_updated_at();
drop trigger if exists gj_accounts_updated_at on public.gj_accounts;
create trigger gj_accounts_updated_at before update on public.gj_accounts for each row execute function public.gj_set_updated_at();
drop trigger if exists gj_trades_updated_at on public.gj_trades;
create trigger gj_trades_updated_at before update on public.gj_trades for each row execute function public.gj_set_updated_at();
drop trigger if exists gj_goals_updated_at on public.gj_goals;
create trigger gj_goals_updated_at before update on public.gj_goals for each row execute function public.gj_set_updated_at();
drop trigger if exists gj_daily_plans_updated_at on public.gj_daily_plans;
create trigger gj_daily_plans_updated_at before update on public.gj_daily_plans for each row execute function public.gj_set_updated_at();
drop trigger if exists gj_notification_settings_updated_at on public.gj_notification_settings;
create trigger gj_notification_settings_updated_at before update on public.gj_notification_settings for each row execute function public.gj_set_updated_at();
drop trigger if exists gj_mt5_connections_updated_at on public.gj_mt5_connections;
create trigger gj_mt5_connections_updated_at before update on public.gj_mt5_connections for each row execute function public.gj_set_updated_at();
drop trigger if exists gj_mt5_live_positions_updated_at on public.gj_mt5_live_positions;
create trigger gj_mt5_live_positions_updated_at before update on public.gj_mt5_live_positions for each row execute function public.gj_set_updated_at();
