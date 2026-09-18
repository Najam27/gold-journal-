-- Apply after 0024. Trade Log evidence durability.
--
-- Why this migration exists
-- -------------------------
-- Three things had to be true for a trade and its screenshot to survive a
-- refresh, a logout, or an account switch, and none of them were guaranteed by
-- the schema:
--
--   1. `gj_trades.clientMutationId` is the idempotency key that lets a durable
--      browser queue replay a write after a lost response WITHOUT creating a
--      duplicate trade. The column and its unique index are re-asserted here so
--      a production project that predates 0013 still gets them.
--   2. `screenshotKey` / `screenshotName` are the only permanent record of a
--      trade's screenshot. A signed URL expires in an hour, so it must never be
--      what the database stores; `screenshotKey` is the stable object path.
--   3. The storage policies from 0002 authorize on the FIRST path segment only,
--      so the account segment was not enforced at the storage layer. Objects are
--      now written as `{authUid}/accounts/{accountId}/trades/{tradeRef}/{file}`
--      and the policies check the account segment too.
--
-- Everything here is additive and safe to run more than once.

-- 1. Trade evidence columns and the replay key.
alter table public.gj_trades add column if not exists "screenshotKey" varchar(500);
alter table public.gj_trades add column if not exists "screenshotName" varchar(255);
alter table public.gj_trades add column if not exists "clientMutationId" varchar(64);

create unique index if not exists gj_trades_owner_account_client_mutation_unique
  on public.gj_trades ("userId", "accountId", "clientMutationId")
  where "clientMutationId" is not null;

-- 2. A screenshot reference must be a bounded, relative object key.
--
--    Absolute URLs are rejected outright, which is what stops an expired signed
--    URL from ever becoming the persisted source of truth. Both constraints are
--    declared NOT VALID so they are enforced for every new and updated row
--    without failing the migration on legacy rows of `gj_trades`. They can be
--    validated later with `alter table public.gj_trades validate constraint ...`.
alter table public.gj_trades drop constraint if exists gj_trades_screenshot_key_shape;
alter table public.gj_trades add constraint gj_trades_screenshot_key_shape
  check (
    "screenshotKey" is null
    or (
      length("screenshotKey") <= 500
      and "screenshotKey" !~ '^(https?:)?//'
      and "screenshotKey" !~ '\.\.'
      and "screenshotKey" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    )
  ) not valid;

-- A stored image always carries the original filename it was uploaded with, so
-- the Trade Log can label it without re-deriving anything from the key.
alter table public.gj_trades drop constraint if exists gj_trades_screenshot_pair;
alter table public.gj_trades add constraint gj_trades_screenshot_pair
  check (
    ("screenshotKey" is null and "screenshotName" is null)
    or ("screenshotKey" is not null and "screenshotName" is not null)
  ) not valid;

-- 3. The screenshot bucket must exist and must stay private. The server mints
--    short-lived signed URLs on read; nothing is ever served anonymously.
insert into storage.buckets (id, name, public)
values ('trade-screenshots', 'trade-screenshots', false)
on conflict (id) do update set public = false;

-- 4. Storage ownership is now account-aware.
--
--    Object keys are `{authUid}/accounts/{accountId}/trades/{tradeRef}/{file}`,
--    so `storage.foldername(name)` is
--    `{authUid, accounts, accountId, trades, tradeRef}`.
create or replace function public.owns_screenshot_account_folder(screenshot_owner_folder text, account_folder text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.owns_screenshot_folder(screenshot_owner_folder)
     and account_folder ~ '^[0-9]{1,12}$'
     and exists (
       select 1
       from public.gj_accounts a
       where a.id = account_folder::integer
         and a."userId" = public.current_journal_user_id()
     );
$$;

revoke all on function public.owns_screenshot_account_folder(text, text) from public, anon;
grant execute on function public.owns_screenshot_account_folder(text, text) to authenticated, service_role;

drop policy if exists "trade screenshots read own folder" on storage.objects;
drop policy if exists "trade screenshots insert own folder" on storage.objects;
drop policy if exists "trade screenshots update own folder" on storage.objects;
drop policy if exists "trade screenshots delete own folder" on storage.objects;

create policy "trade screenshots read own folder" on storage.objects
  for select using (
    bucket_id = 'trade-screenshots'
    and public.owns_screenshot_folder((storage.foldername(name))[1])
    and public.owns_screenshot_account_folder((storage.foldername(name))[1], (storage.foldername(name))[3])
  );
create policy "trade screenshots insert own folder" on storage.objects
  for insert with check (
    bucket_id = 'trade-screenshots'
    and public.owns_screenshot_folder((storage.foldername(name))[1])
    and public.owns_screenshot_account_folder((storage.foldername(name))[1], (storage.foldername(name))[3])
  );
create policy "trade screenshots update own folder" on storage.objects
  for update using (
    bucket_id = 'trade-screenshots'
    and public.owns_screenshot_folder((storage.foldername(name))[1])
    and public.owns_screenshot_account_folder((storage.foldername(name))[1], (storage.foldername(name))[3])
  )
  with check (
    bucket_id = 'trade-screenshots'
    and public.owns_screenshot_folder((storage.foldername(name))[1])
    and public.owns_screenshot_account_folder((storage.foldername(name))[1], (storage.foldername(name))[3])
  );
create policy "trade screenshots delete own folder" on storage.objects
  for delete using (
    bucket_id = 'trade-screenshots'
    and public.owns_screenshot_folder((storage.foldername(name))[1])
    and public.owns_screenshot_account_folder((storage.foldername(name))[1], (storage.foldername(name))[3])
  );

-- 5. Cross-account isolation is enforced by the database for the columns the
--    application relies on: a trade's owner must own its account.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'gj_trades_account_owner_fk'
      and conrelid = 'public.gj_trades'::regclass
  ) then
    alter table public.gj_trades
      add constraint gj_trades_account_owner_fk
      foreign key ("accountId", "userId") references public.gj_accounts (id, "userId");
  end if;
end $$;
