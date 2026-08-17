-- Gold Journal security hardening for existing Supabase projects.
-- The Netlify server uses the service role and therefore bypasses RLS; every
-- server procedure still performs explicit ownership checks.

create or replace function public.current_journal_user_id()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select id
  from public.users
  where "openId" = auth.uid()::text
  limit 1;
$$;

create or replace function public.journal_user_is(target_user_id integer)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_user_id is not null and target_user_id = public.current_journal_user_id();
$$;

create or replace function public.owns_journal_account(target_account_id integer)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.gj_accounts a
    where a.id = target_account_id
      and a."userId" = public.current_journal_user_id()
  );
$$;

create or replace function public.owns_screenshot_folder(folder text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select folder = auth.uid()::text
      or exists (
        select 1
        from public.users u
        where u.id::text = folder
          and u."openId" = auth.uid()::text
      );
$$;

alter table public.users enable row level security;
alter table public.gj_accounts enable row level security;
alter table public.gj_trades enable row level security;
alter table public.gj_cash_movements enable row level security;
alter table public.gj_goals enable row level security;
alter table public.gj_skipped_trades enable row level security;
alter table public.gj_daily_plans enable row level security;
alter table public.gj_option_lists enable row level security;
alter table public.gj_notification_settings enable row level security;
alter table public.gj_notification_history enable row level security;
alter table public.gj_mt5_connections enable row level security;
alter table public.gj_mt5_live_positions enable row level security;

drop policy if exists "users read own row" on public.users;
drop policy if exists "users update own row" on public.users;
create policy "users read own row" on public.users
  for select using (public.journal_user_is(id));
create policy "users update own row" on public.users
  for update using (public.journal_user_is(id))
  with check (public.journal_user_is(id));

drop policy if exists "accounts owner access" on public.gj_accounts;
create policy "accounts owner access" on public.gj_accounts
  for all using (public.journal_user_is("userId"))
  with check (public.journal_user_is("userId"));

drop policy if exists "trades owner access" on public.gj_trades;
create policy "trades owner access" on public.gj_trades
  for all using (public.journal_user_is("userId") and public.owns_journal_account("accountId"))
  with check (public.journal_user_is("userId") and public.owns_journal_account("accountId"));

drop policy if exists "cash owner access" on public.gj_cash_movements;
create policy "cash owner access" on public.gj_cash_movements
  for all using (public.journal_user_is("userId") and public.owns_journal_account("accountId"))
  with check (public.journal_user_is("userId") and public.owns_journal_account("accountId"));

drop policy if exists "goals owner access" on public.gj_goals;
create policy "goals owner access" on public.gj_goals
  for all using (public.journal_user_is("userId") and public.owns_journal_account("accountId"))
  with check (public.journal_user_is("userId") and public.owns_journal_account("accountId"));

drop policy if exists "skipped trades owner access" on public.gj_skipped_trades;
create policy "skipped trades owner access" on public.gj_skipped_trades
  for all using (public.journal_user_is("userId") and public.owns_journal_account("accountId"))
  with check (public.journal_user_is("userId") and public.owns_journal_account("accountId"));

drop policy if exists "daily plans owner access" on public.gj_daily_plans;
create policy "daily plans owner access" on public.gj_daily_plans
  for all using (public.journal_user_is("userId") and public.owns_journal_account("accountId"))
  with check (public.journal_user_is("userId") and public.owns_journal_account("accountId"));

drop policy if exists "option lists owner access" on public.gj_option_lists;
create policy "option lists owner access" on public.gj_option_lists
  for all using (public.journal_user_is("userId"))
  with check (public.journal_user_is("userId"));

drop policy if exists "notification settings owner access" on public.gj_notification_settings;
create policy "notification settings owner access" on public.gj_notification_settings
  for all using (public.journal_user_is("userId"))
  with check (public.journal_user_is("userId"));

drop policy if exists "notification history owner access" on public.gj_notification_history;
create policy "notification history owner access" on public.gj_notification_history
  for all using (
    public.journal_user_is("userId")
    and ("accountId" is null or public.owns_journal_account("accountId"))
  )
  with check (
    public.journal_user_is("userId")
    and ("accountId" is null or public.owns_journal_account("accountId"))
  );

drop policy if exists "mt5 connections owner access" on public.gj_mt5_connections;
create policy "mt5 connections owner access" on public.gj_mt5_connections
  for all using (public.journal_user_is("userId") and public.owns_journal_account("accountId"))
  with check (public.journal_user_is("userId") and public.owns_journal_account("accountId"));

drop policy if exists "mt5 positions owner access" on public.gj_mt5_live_positions;
create policy "mt5 positions owner access" on public.gj_mt5_live_positions
  for all using (public.owns_journal_account("accountId"))
  with check (public.owns_journal_account("accountId"));

drop policy if exists "trade screenshots read own folder" on storage.objects;
drop policy if exists "trade screenshots insert own folder" on storage.objects;
drop policy if exists "trade screenshots update own folder" on storage.objects;
drop policy if exists "trade screenshots delete own folder" on storage.objects;
create policy "trade screenshots read own folder" on storage.objects
  for select using (bucket_id = 'trade-screenshots' and public.owns_screenshot_folder((storage.foldername(name))[1]));
create policy "trade screenshots insert own folder" on storage.objects
  for insert with check (bucket_id = 'trade-screenshots' and public.owns_screenshot_folder((storage.foldername(name))[1]));
create policy "trade screenshots update own folder" on storage.objects
  for update using (bucket_id = 'trade-screenshots' and public.owns_screenshot_folder((storage.foldername(name))[1]))
  with check (bucket_id = 'trade-screenshots' and public.owns_screenshot_folder((storage.foldername(name))[1]));
create policy "trade screenshots delete own folder" on storage.objects
  for delete using (bucket_id = 'trade-screenshots' and public.owns_screenshot_folder((storage.foldername(name))[1]));
