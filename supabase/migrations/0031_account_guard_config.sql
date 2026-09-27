-- Funded-account guard mode: per-account risk limits.
--
-- CONTEXT: prop-firm / funded accounts die by rule breach, not by bad trades.
-- Guard mode stores each account's challenge rules as a jsonb config:
--   { "enabled": true,
--     "accountSize": 100000,
--     "dailyLossLimit": 2000,     // dollars, per calendar day (PKT)
--     "maxDrawdownLimit": 5000,   // dollars, peak-to-trough on equity
--     "maxTradesPerDay": 5 }
-- The client evaluates today's P&L, drawdown, and trade count against these
-- limits live and shows CLEAR / WARNING (>=80%) / BREACHED states.
--
-- SAFETY: a single nullable jsonb column — purely additive, no backfill, no
-- constraint that could reject existing rows. Guarded by an
-- information_schema check so the migration is idempotent.

do $$
begin
  if to_regclass('public.gj_accounts') is null then
    raise notice 'gj_accounts does not exist; skipping 0031';
    return;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gj_accounts'
      and column_name = 'guardConfig'
  ) then
    alter table public.gj_accounts add column "guardConfig" jsonb;
  end if;
end
$$;
