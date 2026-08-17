-- Scale-safe account aggregate used by the server-side journal summary.
-- Apply after 0001_source_gold_journal.sql and 0002_security_rls_and_storage.sql.
create or replace function public.gj_account_cash_net(target_user_id integer, target_account_id integer)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(case when movement."type" = 'DEPOSIT' then movement."amount" else -movement."amount" end), 0)::numeric
  from public.gj_cash_movements as movement
  join public.gj_accounts as account on account."id" = movement."accountId"
  where movement."userId" = target_user_id
    and movement."accountId" = target_account_id
    and account."userId" = target_user_id;
$$;

revoke all on function public.gj_account_cash_net(integer, integer) from public, anon, authenticated;
grant execute on function public.gj_account_cash_net(integer, integer) to service_role;
