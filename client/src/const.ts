export const COOKIE_NAME = "sb-access-token";
export const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
export const UNAUTHED_ERR_MSG = "UNAUTHORIZED";

// Retained as a compatibility event for legacy layout components; the actual
// Supabase login form owns sign-in and sign-up actions.
export const startLogin = () => window.dispatchEvent(new Event("gold-journal:auth-request"));
