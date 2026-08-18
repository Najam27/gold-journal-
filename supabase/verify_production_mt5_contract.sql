-- Read-only verification for Gold Journal MT5 migrations 0001-0009.
-- Run in the Supabase SQL Editor. This script does not modify data or schema.

select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  pg_get_function_result(p.oid) as return_type,
  p.prosecdef as security_definer,
  p.proconfig as function_config,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'gj_sync_mt5_position';

select to_regclass('public.gj_accounts') as accounts_table,
       to_regclass('public.gj_mt5_connections') as connections_table,
       to_regclass('public.gj_mt5_live_positions') as live_positions_table,
       to_regclass('public.gj_trades') as trades_table,
       to_regclass('public.gj_rate_limit_buckets') as rate_limit_table;

select table_name, column_name, data_type, udt_name
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'gj_trades' and column_name in ('userId','accountId','mt5Ticket','openTime','closeTime','mfe','mae'))
    or (table_name = 'gj_mt5_live_positions' and column_name in ('accountId','ticket','status','openTime','closeTime','realizedPnl')))
order by table_name, ordinal_position;

select table_name, constraint_name, constraint_type
from information_schema.table_constraints
where table_schema = 'public'
  and table_name in ('gj_accounts','gj_mt5_live_positions','gj_trades','gj_rate_limit_buckets')
order by table_name, constraint_name;

select schemaname, tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('gj_mt5_live_positions','gj_trades','gj_rate_limit_buckets')
order by tablename, indexname;

select routine_schema, routine_name, privilege_type, grantee
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in ('gj_sync_mt5_position','gj_consume_rate_limit','gj_remove_account')
order by routine_name, grantee, privilege_type;

-- PostgREST RPC smoke check without changing data:
-- select public.gj_sync_mt5_position(
--   <test_user_id>,
--   <test_account_id>,
--   '{"ticket":"999999999","symbol":"XAUUSD","direction":"BUY","lots":"0.01","openPrice":"1","closePrice":null,"slPrice":null,"tpPrice":null,"riskUsd":"0","rewardUsd":"0","rrRatio":"0","floatingPnl":"0","realizedPnl":null,"result":"OPEN","openTime":"2026-01-01T00:00:00Z","closeTime":null,"status":"OPEN","session":"London","tradeTime":"2026-01-01T00:00:00Z","pnl":"0"}'::jsonb
-- );
-- Only use a dedicated test account and synthetic ticket for the commented smoke call.
