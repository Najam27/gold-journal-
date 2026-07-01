// =====================================================================
// Gold Journal — configuration
// ---------------------------------------------------------------------
// Fill in your Supabase project credentials below. Both values are
// public / safe to ship in a static site (the anon key is protected by
// Row Level Security). NEVER put your service_role key here.
//
// Find them in: Supabase Dashboard -> Project Settings -> API
// =====================================================================

export const SUPABASE_URL = window.__GJ_SUPABASE_URL__ || "YOUR_SUPABASE_URL";
export const SUPABASE_ANON_KEY =
  window.__GJ_SUPABASE_ANON_KEY__ || "YOUR_SUPABASE_ANON_KEY";

// Storage bucket used for trade screenshots (created by schema.sql).
export const SCREENSHOTS_BUCKET = "screenshots";

// AI Mentor default model (used with the user-supplied OpenRouter key).
export const AI_MODEL = "openai/gpt-4o-mini";

export const isConfigured = () =>
  SUPABASE_URL &&
  SUPABASE_ANON_KEY &&
  !SUPABASE_URL.startsWith("YOUR_") &&
  !SUPABASE_ANON_KEY.startsWith("YOUR_");
