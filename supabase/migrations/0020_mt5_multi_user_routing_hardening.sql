-- Additive multi-user MT5 routing hardening. Existing visible account names,
-- account IDs, connections, positions, and journal rows remain unchanged.
begin;

alter table public.gj_accounts
  add column if not exists "normalizedName" varchar(120);

with ranked_names as (
  select
    account."id",
    lower(regexp_replace(trim(account."name"), '\\s+', ' ', 'g')) as base_name,
    row_number() over (
      partition by account."userId", lower(regexp_replace(trim(account."name"), '\\s+', ' ', 'g'))
      order by account."createdAt", account."id"
    ) as name_rank
  from public.gj_accounts account
)
update public.gj_accounts account
set "normalizedName" = case
  when ranked_names.name_rank = 1 then ranked_names.base_name
  else ranked_names.base_name || '--legacy-' || account."id"::text
end
from ranked_names
where account."id" = ranked_names."id"
  and account."normalizedName" is null;

alter table public.gj_accounts
  alter column "normalizedName" set not null;

create unique index if not exists "gj_accounts_user_normalized_name_unique"
  on public.gj_accounts ("userId", "normalizedName");

create index if not exists "gj_mt5_connection_owner_active_contact_idx"
  on public.gj_mt5_connections ("userId", "active", "lastContactAt" desc)
  where "retiredAt" is null;

commit;
