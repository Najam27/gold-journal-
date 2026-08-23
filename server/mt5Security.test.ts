import { describe, expect, it } from "vitest";
import { mt5ApiKeyFingerprint, mt5ConnectionReference } from "./mt5Security";

describe("MT5 API-key verifier", () => {
  it("derives a deterministic non-secret SHA-256 verifier", () => {
    const raw = "mt5_live_key_a_realistic_secret_value_1234567890";
    const fingerprint = mt5ApiKeyFingerprint(raw);
    expect(fingerprint).toHaveLength(64);
    expect(fingerprint).not.toContain(raw);
    expect(fingerprint).toBe(mt5ApiKeyFingerprint(raw));
    expect(fingerprint).not.toBe(mt5ApiKeyFingerprint(`${raw}-different`));
  });

  it("derives a safe visible connection reference only from a SHA-256 fingerprint", () => {
    const raw = "mt5_live_key_a_realistic_secret_value_1234567890";
    const fingerprint = mt5ApiKeyFingerprint(raw);
    const reference = mt5ConnectionReference(fingerprint);
    expect(reference).toMatch(/^gjmt5-[a-f0-9]{12}$/);
    expect(reference).not.toContain(raw);
    expect(mt5ConnectionReference(raw)).toBeNull();
  });
});
