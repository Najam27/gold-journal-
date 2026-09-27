-- Retire the server-side AI vault (migrations 0014, 0015).
--
-- CONTEXT: 0014 created gj_ai_provider_settings (server-held encrypted provider
-- keys) and 0015 created gj_ai_jobs (a durable queue for Netlify Background
-- Functions). The application has since moved to a browser-direct AI
-- architecture: keys live in the trader's own browser storage and every AI
-- request goes straight from the browser to the provider. No deployed code
-- path reads or writes either table (verified by repository-wide search), and
-- both tables are locked to service_role, so no client could have written rows
-- through the app. They are removed here so the schema no longer implies a
-- server AI pipeline that does not exist.
--
-- SAFETY: these tables can hold encrypted provider credentials, so the drops
-- are guarded — the migration refuses to run if either table holds rows, and
-- it fails loudly instead of silently discarding them. If the guard ever
-- trips, investigate the out-of-band writer before re-applying.

do $$
begin
  if to_regclass('public.gj_ai_provider_settings') is not null
     and exists (select 1 from public.gj_ai_provider_settings) then
    raise exception 'Refusing to retire gj_ai_provider_settings: the table is not empty. Investigate the writer before dropping.';
  end if;
  if to_regclass('public.gj_ai_jobs') is not null
     and exists (select 1 from public.gj_ai_jobs) then
    raise exception 'Refusing to retire gj_ai_jobs: the table is not empty. Investigate the writer before dropping.';
  end if;
end
$$;

drop table if exists public.gj_ai_jobs;
drop table if exists public.gj_ai_provider_settings;
