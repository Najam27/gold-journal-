# Drizzle schema metadata

The runtime database is Supabase PostgreSQL. `schema.ts` is retained as the TypeScript/Drizzle table model used by the PostgREST adapter and tests.

The former `0000`–`0008` Drizzle migration lineage was a stale MySQL migration stream and is intentionally removed from the active repository. It was not referenced by package scripts, runtime code, or deployment configuration.

Supabase SQL migrations are the only database migration source of truth. Apply `supabase/migrations/0001` through `0006` in order. Do not run Drizzle migrations against the Supabase project.
