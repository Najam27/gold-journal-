const configuredRedirect = (import.meta.env.VITE_AUTH_REDIRECT_URL as string | undefined)?.trim();

function normalizeCandidate(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export function getAuthRedirectUrl(location: Pick<WindowLocation, "origin" | "pathname"> = window.location, override = configuredRedirect) {
  return normalizeCandidate(override) ?? `${location.origin}${location.pathname || "/"}`;
}

type WindowLocation = { origin: string; pathname: string };
