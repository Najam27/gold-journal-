-- Apply after 0023. Canonical Trade Log option system for gj_option_lists.
--
-- Why: the Trade Log mixed hard-coded dropdown arrays with custom rows in this
-- table, so the provided defaults could not be renamed, disabled, or managed at
-- all. The defaults are now seeded into this table as ordinary editable rows.
--
-- What changes:
--   "normalizedValue"  case/whitespace-insensitive comparison key, used to
--                      prevent "A", "a" and " A " from becoming separate
--                      options in the same category.
--   "isDefault"        the option was provided by Gold Journal initially. This
--                      is provenance only: the row is fully editable.
--   "seedKey"          deterministic identity of a seeded default. Because it
--                      is stored, renaming a default never re-creates the
--                      original label on a later seed pass (the seed operation
--                      is idempotent and non-destructive).
--   "updatedAt"        last rename/enable/disable, for the manager UI.
--
-- This migration is additive and safe to run more than once. It never deletes
-- a row, never rewrites a `value`, and never touches gj_trades: historical
-- labels stay exactly as recorded. Trades keep storing the recorded label
-- (historical-snapshot semantics) and the UI additionally renders any recorded
-- value that no longer matches an active option as "<value> — Archived", so old
-- trades are never blanked or silently re-pointed.

-- 1. New columns (idempotent) --------------------------------------------------
alter table public.gj_option_lists
  add column if not exists "normalizedValue" varchar(160),
  add column if not exists "isDefault" boolean not null default false,
  add column if not exists "seedKey" varchar(120),
  add column if not exists "updatedAt" timestamptz not null default now();

-- 2. Backfill the comparison key for every existing row ------------------------
-- lower(btrim(value)) matches normalizeTradeOptionValue().replace(/\s+/g,' ') for
-- the values this journal stores, and it is safe for any pre-existing text.
update public.gj_option_lists
   set "normalizedValue" = lower(regexp_replace(btrim("value"), '\s+', ' ', 'g'))
 where "normalizedValue" is null or "normalizedValue" = '';

alter table public.gj_option_lists
  alter column "normalizedValue" set not null;

-- 3. Stable seed identity + category lookups -----------------------------------
-- A non-partial unique index is required so `on conflict ("userId", "seedKey")`
-- can infer it. NULL seed keys stay distinct in PostgreSQL, so user-created
-- options (seedKey is null) are unaffected by this constraint.
create unique index if not exists gj_option_list_owner_seed_unique
  on public.gj_option_lists ("userId", "seedKey");

create index if not exists gj_option_list_owner_category_idx
  on public.gj_option_lists ("userId", "category", "active");

-- 4. Keep "updatedAt" owned by PostgreSQL --------------------------------------
-- public.gj_set_updated_at() is created by 0006 with `set search_path = public`;
-- this migration only attaches it to the option table (it is never redefined).
drop trigger if exists gj_option_lists_updated_at on public.gj_option_lists;
create trigger gj_option_lists_updated_at
  before update on public.gj_option_lists
  for each row execute function public.gj_set_updated_at();
