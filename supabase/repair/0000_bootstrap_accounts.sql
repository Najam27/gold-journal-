-- Run this file first if the old migration fails at owns_account().
-- It is safe to run more than once.

create extension if not exists pgcrypto;

create table if not exists public.trading_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  broker_name text,
  base_currency text not null default 'USD',
  starting_balance numeric,
  is_active boolean not null default true,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.owns_account(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.trading_accounts
    where id = target
      and owner_id = auth.uid()
      and is_archived = false
  );
$$;
