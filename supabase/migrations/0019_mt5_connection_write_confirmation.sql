-- Confirms that MT5 Live contact and snapshot writes changed the exact authenticated
-- connection row. This is additive and does not delete, retire, recreate, or move data.

create or replace function public.gj_touch_mt5_connection(
  target_connection_id integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.gj_mt5_connections
     set "lastPing" = now(),
         "lastContactAt" = now(),
         "updatedAt" = now()
   where "id" = target_connection_id;
  return found;
end;
$$;

revoke all on function public.gj_touch_mt5_connection(integer) from public, anon, authenticated;
grant execute on function public.gj_touch_mt5_connection(integer) to service_role;

create or replace function public.gj_update_mt5_connection_summary(
  target_connection_id integer,
  summary_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  has_risk_spec boolean := coalesce(summary_payload ? 'riskSymbol', false)
    and summary_payload->>'riskSymbol' is not null
    and summary_payload->>'riskTickSize' is not null
    and summary_payload->>'riskTickValueLoss' is not null
    and summary_payload->>'riskContractSize' is not null
    and summary_payload->>'riskVolumeMin' is not null
    and summary_payload->>'riskVolumeMax' is not null
    and summary_payload->>'riskVolumeStep' is not null;
begin
  if jsonb_typeof(summary_payload) <> 'object'
    or coalesce(summary_payload->>'mt5Login', '') !~ '^[0-9]+$'
    or coalesce(summary_payload->>'brokerServer', '') = ''
    or coalesce(summary_payload->>'currency', '') = '' then
    raise exception 'invalid MT5 account summary' using errcode = '22023';
  end if;

  update public.gj_mt5_connections
     set "mt5Login" = (summary_payload->>'mt5Login')::bigint,
         "brokerServer" = left(summary_payload->>'brokerServer', 160),
         "currency" = left(summary_payload->>'currency', 16),
         "balance" = (summary_payload->>'balance')::numeric(14, 2),
         "equity" = (summary_payload->>'equity')::numeric(14, 2),
         "margin" = (summary_payload->>'margin')::numeric(14, 2),
         "freeMargin" = (summary_payload->>'freeMargin')::numeric(14, 2),
         "floatingPnl" = (summary_payload->>'floatingPnl')::numeric(14, 2),
         "riskSymbol" = case when has_risk_spec then left(summary_payload->>'riskSymbol', 32) else "riskSymbol" end,
         "riskTickSize" = case when has_risk_spec then (summary_payload->>'riskTickSize')::numeric(18, 8) else "riskTickSize" end,
         "riskTickValueLoss" = case when has_risk_spec then (summary_payload->>'riskTickValueLoss')::numeric(18, 8) else "riskTickValueLoss" end,
         "riskContractSize" = case when has_risk_spec then (summary_payload->>'riskContractSize')::numeric(18, 8) else "riskContractSize" end,
         "riskVolumeMin" = case when has_risk_spec then (summary_payload->>'riskVolumeMin')::numeric(18, 8) else "riskVolumeMin" end,
         "riskVolumeMax" = case when has_risk_spec then (summary_payload->>'riskVolumeMax')::numeric(18, 8) else "riskVolumeMax" end,
         "riskVolumeStep" = case when has_risk_spec then (summary_payload->>'riskVolumeStep')::numeric(18, 8) else "riskVolumeStep" end,
         "riskSymbolUpdatedAt" = case when has_risk_spec then now() else "riskSymbolUpdatedAt" end,
         "lastPing" = now(),
         "lastContactAt" = now(),
         "lastSummaryAt" = now(),
         "lastSummarySuccessAt" = now(),
         "lastErrorAt" = null,
         "lastErrorCode" = null,
         "lastErrorMessage" = null,
         "consecutiveFailures" = 0,
         "updatedAt" = now()
   where "id" = target_connection_id;
  return found;
end;
$$;

revoke all on function public.gj_update_mt5_connection_summary(integer, jsonb) from public, anon, authenticated;
grant execute on function public.gj_update_mt5_connection_summary(integer, jsonb) to service_role;
