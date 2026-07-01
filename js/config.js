// =====================================================================
// Gold Journal — configuration
// ---------------------------------------------------------------------
// Credentials are NEVER hardcoded here. They are injected at build time
// from environment variables (Netlify env vars in production, a local
// .env file in development) by build.js, which writes js/env.js. That
// file sets window.__GJ_SUPABASE_URL__ / window.__GJ_SUPABASE_ANON_KEY__
// before this module runs.
//
// Both values are public / safe to ship in a static site (the anon key
// is protected by Row Level Security). The service_role key must NEVER
// be used in frontend code.
// =====================================================================

export const SUPABASE_URL = (window.__GJ_SUPABASE_URL__ || "").trim();
export const SUPABASE_ANON_KEY = (window.__GJ_SUPABASE_ANON_KEY__ || "").trim();

// Storage bucket used for trade screenshots (created by schema.sql).
export const SCREENSHOTS_BUCKET = "screenshots";

// AI Mentor default model (used with the user-supplied OpenRouter key).
export const AI_MODEL = "openai/gpt-4o-mini";

export const isConfigured = () =>
  Boolean(SUPABASE_URL) &&
  Boolean(SUPABASE_ANON_KEY) &&
  /^https?:\/\//.test(SUPABASE_URL);
