-- Repair legacy copied connection rows whose denormalized userId no longer
-- matches their journal account owner. This changes no account, trade, position,
-- or API-key value and does not delete data.
update public.gj_mt5_connections as connection
set "userId" = account."userId"
from public.gj_accounts as account
where connection."accountId" = account."id"
  and connection."userId" is distinct from account."userId";

-- Lock the repaired relationship so a future copied/imported row cannot become
-- invisible to its selected account while still accepting an EA API key.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'gj_mt5_connection_account_owner_fk'
  ) then
    alter table public.gj_mt5_connections
      add constraint gj_mt5_connection_account_owner_fk
      foreign key ("accountId", "userId")
      references public.gj_accounts("id", "userId")
      on delete cascade;
  end if;
end;
$$;
