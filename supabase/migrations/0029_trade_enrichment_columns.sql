-- Trade journal enrichment: plan-following score, quick-log marker, price fields.
--
-- CONTEXT: five nullable columns on gj_trades, all additive and all safe to
-- apply to a live journal:
--   * "planFollowScore"  integer 1-5, the trader's self-rated plan-following
--     score for the trade (Steve Burns' minimum-journal checklist). Nullable:
--     old trades and MT5 imports simply have no rating.
--   * "quickLogged"      boolean, true when the trade was captured through the
--     2-minute quick-log mode and still needs its details completed.
--   * "entryPrice" / "slPrice" / "tpPrice"  numeric prices captured by
--     quick-log (and the full dialog) so a fast capture still records the
--     levels. Nullable: the full dialog never required them.
--
-- SAFETY: every ADD COLUMN is guarded by an information_schema check so the
-- migration is idempotent — safe on a fresh database, safe to re-run after a
-- partial apply. The planFollowScore check constraint is added only when the
-- column exists and the constraint does not. No existing rows are touched and
-- no backfill is needed: NULL is the correct value for "not recorded".

do $$
begin
  if to_regclass('public.gj_trades') is null then
    raise notice 'gj_trades does not exist; skipping 0029';
    return;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gj_trades'
      and column_name = 'planFollowScore'
  ) then
    alter table public.gj_trades add column "planFollowScore" integer;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gj_trades'
      and column_name = 'quickLogged'
  ) then
    alter table public.gj_trades add column "quickLogged" boolean not null default false;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gj_trades'
      and column_name = 'entryPrice'
  ) then
    alter table public.gj_trades add column "entryPrice" numeric(18, 6);
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gj_trades'
      and column_name = 'slPrice'
  ) then
    alter table public.gj_trades add column "slPrice" numeric(18, 6);
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gj_trades'
      and column_name = 'tpPrice'
  ) then
    alter table public.gj_trades add column "tpPrice" numeric(18, 6);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'gj_trades_plan_follow_score_valid'
  ) then
    alter table public.gj_trades
      add constraint gj_trades_plan_follow_score_valid
      check ("planFollowScore" is null or "planFollowScore" between 1 and 5);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'gj_trades_prices_nonnegative'
  ) then
    alter table public.gj_trades
      add constraint gj_trades_prices_nonnegative
      check (
        ("entryPrice" is null or "entryPrice" >= 0)
        and ("slPrice" is null or "slPrice" >= 0)
        and ("tpPrice" is null or "tpPrice" >= 0)
      );
  end if;
end
$$;
