/**
 * Framework- and platform-neutral MT5 EA template rendering helpers.
 *
 * Shared by the Node dev server (Express), the standalone Node production
 * server, and the Cloudflare Worker entry. This module deliberately imports no
 * Node built-ins so it can be bundled for Workers unchanged.
 */
export const EA_ENDPOINT_TOKEN = "__GOLD_JOURNAL_MT5_ENDPOINT__";

export function firstForwardedValue(value: string | string[] | undefined) {
  const source = Array.isArray(value) ? value[0] : value;
  return source?.split(",")[0]?.trim() || "";
}

function validPublicHost(host: string) {
  return /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host) && !host.includes("..");
}

/**
 * Pure endpoint derivation used by every deployment target (Node dev server
 * and Cloudflare Workers) so a downloaded EA always targets the exact backend
 * that issued its key.
 */
export function buildMt5Endpoint(input: {
  forwardedHost?: string | string[];
  host?: string;
  forwardedProto?: string | string[];
  protocol?: string;
  defaultProtocol?: string;
}) {
  const host = firstForwardedValue(input.forwardedHost) || input.host || "";
  if (!validPublicHost(host)) return null;
  const forwardedProtocol = firstForwardedValue(input.forwardedProto);
  const protocol =
    forwardedProtocol === "https" || forwardedProtocol === "http"
      ? forwardedProtocol
      : input.protocol === "https"
        ? "https"
        : input.defaultProtocol === "http"
          ? "http"
          : "https";
  return `${protocol}://${host}/api/mt5`;
}

export function renderMt5EaTemplate(templateSource: string, endpoint: string | null) {
  if (!templateSource) return null;
  return endpoint ? templateSource.replace(EA_ENDPOINT_TOKEN, endpoint) : null;
}

/** A rendered EA must still contain the .mq5 program markers; guards against
 * an empty or truncated build-time template reaching traders. */
export function hasPlausibleEaSource(source: string) {
  return source.length > 1_000 && source.includes("HasConfiguredEndpoint") && source.includes("__GOLD_JOURNAL_MT5_ENDPOINT__");
}
