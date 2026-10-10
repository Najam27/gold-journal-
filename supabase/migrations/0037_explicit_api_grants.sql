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

revoke all on table public.users from public, anon, authenticated;
grant select, insert, update, delete on table public.users to service_role;
revoke all on table public.gj_rate_limit_buckets from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_rate_limit_buckets to service_role;
revoke all on table public.gj_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_accounts to service_role;
revoke all on table public.gj_trades from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_trades to service_role;
revoke all on table public.gj_cash_movements from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_cash_movements to service_role;
revoke all on table public.gj_goals from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_goals to service_role;
revoke all on table public.gj_weekly_reviews from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_weekly_reviews to service_role;
revoke all on table public.gj_skipped_trades from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_skipped_trades to service_role;
revoke all on table public.gj_daily_plans from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_daily_plans to service_role;
revoke all on table public.gj_option_lists from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_option_lists to service_role;
revoke all on table public.gj_notification_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_notification_settings to service_role;
revoke all on table public.gj_notification_history from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_notification_history to service_role;
revoke all on table public.gj_mt5_connections from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_mt5_connections to service_role;
revoke all on table public.gj_ai_reports from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_ai_reports to service_role;
revoke all on table public.gj_ai_edge_history from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_ai_edge_history to service_role;
revoke all on table public.gj_ai_experiment_history from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_ai_experiment_history to service_role;
revoke all on table public.gj_mt5_live_positions from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_mt5_live_positions to service_role;
revoke all on table public.gj_trader_profiles from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_trader_profiles to service_role;
revoke all on table public.gj_ai_provider_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_ai_provider_settings to service_role;
revoke all on table public.gj_ai_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_ai_jobs to service_role;

-- Serial-PK sequences, present and future: inserts through
-- service_role need USAGE + SELECT on every sequence.
grant usage, select on all sequences in schema public to service_role;
