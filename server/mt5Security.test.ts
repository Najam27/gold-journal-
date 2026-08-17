import { describe, expect, it } from "vitest";
import { mt5ApiKeyFingerprint } from "./mt5Security";

describe("MT5 API-key verifier", () => {
  it("derives a deterministic non-secret SHA-256 verifier", () => {
    const raw = "mt5_live_key_a_realistic_secret_value_1234567890";
    const fingerprint = mt5ApiKeyFingerprint(raw);
    expect(fingerprint).toHaveLength(64);
    expect(fingerprint).not.toContain(raw);
    expect(fingerprint).toBe(mt5ApiKeyFingerprint(raw));
    expect(fingerprint).not.toBe(mt5ApiKeyFingerprint(`${raw}-different`));
  });
});
