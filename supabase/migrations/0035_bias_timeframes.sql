-- Multi-timeframe Bias: structured per-timeframe market context for the Trade Log.
--
-- - `biasTimeframes` (jsonb, nullable) stores { D1, H4, H1, M15, M5 }, each
--   "Bull" | "Bear" | null. Nullable with no default: existing rows keep NULL
--   (no bias recorded) and no backfill runs, so historical trades are untouched.
-- - The legacy `biasAlignment` text column ("Direction vs bias") is preserved
--   as-is for history. Old values ("Aligned", "Counter-trend", "Neutral",
--   customs) describe trade-vs-bias and cannot be mapped to per-timeframe
--   Bull/Bear, so they are never converted — only left alone.
-- Shape validation lives in the application (zod); the column accepts any
-- JSON so future timeframe additions never need a schema change.
-- Additive and idempotent.

alter table public.gj_trades
  add column if not exists "biasTimeframes" jsonb;
