/**
 * Base origin for the Gold Journal API.
 *
 * Defaults to the same origin as the frontend (Cloudflare Worker Assets, the
 * previous Netlify deployment, and `pnpm dev` all serve the API under /api on
 * the app origin). Set VITE_API_BASE_URL only when the API is hosted
 * separately from the frontend, e.g. a staging frontend on one origin with
 * the API worker on another.
 */
const configured = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
export const apiBaseUrl = configured ? configured.replace(/\/+$/, "") : "";
