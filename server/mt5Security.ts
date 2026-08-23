import { createHash } from "crypto";

export function mt5ApiKeyFingerprint(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * A non-secret identity tag for an already-hashed MT5 API key. It lets a
 * terminal and the account-scoped UI prove they resolved the same connection
 * without exposing any portion of the original one-time API key.
 */
export function mt5ConnectionReference(storedApiKey: string) {
  return /^[a-f0-9]{64}$/i.test(storedApiKey)
    ? `gjmt5-${storedApiKey.slice(0, 12).toLowerCase()}`
    : null;
}
