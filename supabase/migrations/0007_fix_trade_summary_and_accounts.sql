-- Production hotfix after 0001 through 0006.
-- Fixes the PL/pgSQL RETURNS TABLE `pnl` collision by qualifying every trade column.
-- This migration is safe to re-run and does not expose the RPC to browser roles.

create or replace function public.gj_account_trade_summary(
  target_user_id integer,
  target_account_id integer
)
returns table (
  total_trades bigint,
  closed_trades bigint,
  win_trades bigint,
  loss_trades bigint,
  pnl numeric
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.gj_accounts as account
    where account."id" = target_account_id
      and account."userId" = target_user_id
  ) then
    raise exception 'account unavailable' using errcode = '42501';
  end if;

  return query
  select
    count(*)::bigint as total_trades,
    count(*) filter (where trade."result" <> 'OPEN')::bigint as closed_trades,
    count(*) filter (where trade."result" = 'WIN')::bigint as win_trades,
    count(*) filter (where trade."result" = 'LOSS')::bigint as loss_trades,
    coalesce(sum(trade."pnl"), 0)::numeric as pnl
  from public.gj_trades as trade
  where trade."userId" = target_user_id
    and trade."accountId" = target_account_id;
end;
$$;

revoke all on function public.gj_account_trade_summary(integer, integer) from public, anon, authenticated;
grant execute on function public.gj_account_trade_summary(integer, integer) to service_role;
