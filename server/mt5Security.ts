import { createHash } from "crypto";

export function mt5ApiKeyFingerprint(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex");
}
