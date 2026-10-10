-- Explicit Data API grants for every application table.
--
-- Supabase stops auto-exposing new public tables to the Data API
-- on 2026-10-30: without an explicit GRANT a new table is invisible
-- to PostgREST -- including for service_role, the only role the
-- server uses. These grants change nothing on a live project today
-- (the tables already carry their auto-grants) but make the
-- migration history replay-safe for fresh projects, preview
-- branches, and database resets after the cutover. Additive and
-- idempotent: GRANT/REVOKE are safe to re-run.
--
-- Defensive by design: each table is only touched when it actually exists
-- (to_regclass check). A partially-migrated database can therefore never
-- abort this migration with 42P01 — missing tables are skipped with a
-- notice instead of failing the whole run.
--
-- NOTE: gj_ai_provider_settings and gj_ai_jobs are deliberately absent from
-- the list below. Migration 0028 retired the server-side AI vault and DROPS
-- both tables, so they do not exist on any properly migrated database.

do $$
declare
  t text;
begin
  foreach t in array array[
    'users',
    'gj_rate_limit_buckets',
    'gj_accounts',
    'gj_trades',
    'gj_cash_movements',
    'gj_goals',
    'gj_weekly_reviews',
    'gj_skipped_trades',
    'gj_daily_plans',
    'gj_option_lists',
    'gj_notification_settings',
    'gj_notification_history',
    'gj_mt5_connections',
    'gj_ai_reports',
    'gj_ai_edge_history',
    'gj_ai_experiment_history',
    'gj_mt5_live_positions',
    'gj_trader_profiles'
  ]
  loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on table public.%I from public, anon, authenticated', t);
      execute format('grant select, insert, update, delete on table public.%I to service_role', t);
    else
      raise notice '0037: skipping missing table public.%', t;
    end if;
  end loop;
end
$$;

-- Serial-PK sequences, present and future: inserts through
-- service_role need USAGE + SELECT on every sequence.
grant usage, select on all sequences in schema public to service_role;
