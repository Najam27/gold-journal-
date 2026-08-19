-- Apply after 0010. Batches one EA history payload inside a single service-role-only
-- PostgreSQL transaction while reusing the existing terminal CLOSE protection.

create or replace function public.gj_sync_mt5_history_batch(
  target_user_id integer,
  target_account_id integer,
  position_payloads jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  position_payload jsonb;
  synchronized integer := 0;
begin
  if jsonb_typeof(position_payloads) <> 'array' then
    raise exception 'position_payloads must be a JSON array' using errcode = '22023';
  end if;

  perform 1
    from public.gj_accounts
   where "id" = target_account_id
     and "userId" = target_user_id
   for update;
  if not found then
    raise exception 'account unavailable' using errcode = '42501';
  end if;

  for position_payload in select value from jsonb_array_elements(position_payloads)
  loop
    perform public.gj_sync_mt5_position(target_user_id, target_account_id, position_payload);
    synchronized := synchronized + 1;
  end loop;

  return synchronized;
end;
$$;

revoke all on function public.gj_sync_mt5_history_batch(integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.gj_sync_mt5_history_batch(integer, integer, jsonb) to service_role;
