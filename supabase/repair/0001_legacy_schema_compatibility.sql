-- Gold Journal legacy-schema compatibility patch
-- Run this after 0000_bootstrap_accounts.sql and before
-- supabase/migrations/0001_gold_journal.sql.
-- This preserves legacy rows from public.accounts/public.trades.

create extension if not exists pgcrypto;

-- Keep account UUIDs stable so existing account_id values remain valid.
do $$
begin
  if to_regclass('public.accounts') is not null then
    insert into public.trading_accounts
      (id, owner_id, name, starting_balance, is_active, is_archived, created_at, updated_at)
    select id, user_id, name, starting_balance, true, false, created_at, updated_at
    from public.accounts
    on conflict (id) do update set
      owner_id = excluded.owner_id,
      name = excluded.name,
      starting_balance = excluded.starting_balance,
      updated_at = excluded.updated_at;
  end if;
end $$;

-- Legacy trades used trade_date/session/side/risk_amount/reward_amount/pnl.
do $$
begin
  if to_regclass('public.trades') is not null then
    alter table public.trades add column if not exists trade_at_utc timestamptz;
    alter table public.trades add column if not exists pkt_session text;
    alter table public.trades add column if not exists source text default 'manual';
    alter table public.trades add column if not exists mt5_ticket bigint;
    alter table public.trades add column if not exists direction text;
    alter table public.trades add column if not exists risk_usd numeric;
    alter table public.trades add column if not exists planned_reward_usd numeric;
    alter table public.trades add column if not exists realized_pnl numeric;
    alter table public.trades add column if not exists bias text;
    alter table public.trades add column if not exists behavior_tags text[] default '{}';
    alter table public.trades add column if not exists patience_score smallint;

    -- The old hold_quality was free-form text; preserve it and create the new score field.
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='trades' and column_name='hold_quality' and data_type='text') then
      alter table public.trades rename column hold_quality to hold_quality_note;
      alter table public.trades add column if not exists hold_quality smallint;
    end if;

    update public.trades
    set trade_at_utc = coalesce(trade_at_utc, (trade_date::timestamp at time zone 'UTC'))
    where trade_at_utc is null and trade_date is not null;

    update public.trades
    set pkt_session = coalesce(pkt_session, session, 'Post-NY')
    where pkt_session is null;

    update public.trades
    set direction = case
      when lower(coalesce(side, '')) in ('buy', 'long') then 'Long'
      when lower(coalesce(side, '')) in ('sell', 'short') then 'Short'
      else direction
    end
    where direction is null;

    update public.trades set risk_usd = coalesce(risk_usd, risk_amount);
    update public.trades set planned_reward_usd = coalesce(planned_reward_usd, reward_amount);
    update public.trades set realized_pnl = coalesce(realized_pnl, pnl);
    update public.trades set bias = coalesce(bias, bias_alignment);
    update public.trades set behavior_tags = case when mistake is null or btrim(mistake) = '' then '{}' else array[mistake] end where behavior_tags is null;

    alter table public.trades alter column trade_at_utc set not null;
    alter table public.trades alter column pkt_session set not null;
    alter table public.trades alter column source set default 'manual';
    update public.trades set source = 'manual' where source is null;
    alter table public.trades alter column source set not null;
    alter table public.trades alter column behavior_tags set default '{}';
    alter table public.trades alter column behavior_tags set not null;
  end if;
end $$;

-- The old skipped_trades table has the same name but different columns.
do $$
begin
  if to_regclass('public.skipped_trades') is not null then
    alter table public.skipped_trades add column if not exists skipped_at timestamptz;
    alter table public.skipped_trades add column if not exists pkt_session text;
    alter table public.skipped_trades add column if not exists reason text;
    alter table public.skipped_trades add column if not exists later_outcome text;
    alter table public.skipped_trades add column if not exists estimated_missed_pnl numeric;

    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='skipped_trades' and column_name='confidence' and data_type in ('integer','smallint','numeric')) then
      alter table public.skipped_trades rename column confidence to confidence_score;
      alter table public.skipped_trades add column if not exists confidence text;
    end if;

    update public.skipped_trades set skipped_at = coalesce(skipped_at, (trade_date::timestamp at time zone 'UTC')) where skipped_at is null and trade_date is not null;
    update public.skipped_trades set pkt_session = coalesce(pkt_session, session, 'Post-NY') where pkt_session is null;
    update public.skipped_trades set reason = coalesce(reason, skip_reason);
    update public.skipped_trades set later_outcome = coalesce(later_outcome, outcome);
    update public.skipped_trades set estimated_missed_pnl = coalesce(estimated_missed_pnl, est_missed);
    update public.skipped_trades set confidence = coalesce(confidence, confidence_score::text) where confidence is null and confidence_score is not null;

    alter table public.skipped_trades alter column skipped_at set not null;
    alter table public.skipped_trades alter column pkt_session set not null;
  end if;
end $$;

-- The old daily_plans table is retained; add the new app-facing fields.
do $$
begin
  if to_regclass('public.daily_plans') is not null then
    alter table public.daily_plans add column if not exists pre_market_plan text;
    alter table public.daily_plans add column if not exists thesis text;
    alter table public.daily_plans add column if not exists scenarios text;
    alter table public.daily_plans add column if not exists invalidation text;
    alter table public.daily_plans add column if not exists news_context text;
    alter table public.daily_plans add column if not exists risk_limits text;
    alter table public.daily_plans add column if not exists selected_rules text[] default '{}';
    alter table public.daily_plans add column if not exists execution_checklist jsonb default '{}';
    alter table public.daily_plans add column if not exists post_session_score smallint;
    alter table public.daily_plans add column if not exists review_notes text;
    alter table public.daily_plans add column if not exists is_archived boolean default false;
    update public.daily_plans set pre_market_plan = coalesce(pre_market_plan, plan_notes), thesis = coalesce(thesis, pre_bias), selected_rules = coalesce(selected_rules, '{}'), execution_checklist = coalesce(execution_checklist, '{}'), is_archived = coalesce(is_archived, false);
  end if;
end $$;

-- Preserve ticket deduplication for MT5 reconciliation on the legacy trades table.
do $$
begin
  if to_regclass('public.trades') is not null and not exists (select 1 from pg_constraint where conname = 'trades_account_mt5_ticket_key') then
    alter table public.trades add constraint trades_account_mt5_ticket_key unique (account_id, mt5_ticket);
  end if;
exception when duplicate_object then null;
end $$;
