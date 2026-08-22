import { afterEach, describe, expect, it } from "vitest";
import { userAiProviderVaultTestHooks } from "./userAiProviderVault";

describe("encrypted user AI provider vault", () => {
  const originalSecret = process.env.AI_KEY_ENCRYPTION_SECRET;
  const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  afterEach(() => {
    if (originalSecret) process.env.AI_KEY_ENCRYPTION_SECRET = originalSecret;
    else delete process.env.AI_KEY_ENCRYPTION_SECRET;
    if (originalServiceRoleKey) process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRoleKey;
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("encrypts provider credentials and exposes only a masked identifier", () => {
    process.env.AI_KEY_ENCRYPTION_SECRET = "test-only-vault-master-secret";
    const rawKey = "test-provider-key-01234567890";
    const sealed = userAiProviderVaultTestHooks.encrypt(rawKey);
    expect(JSON.stringify(sealed)).not.toContain(rawKey);
    expect(userAiProviderVaultTestHooks.decrypt({ userId: 1, ...sealed, keyFingerprint: userAiProviderVaultTestHooks.fingerprint(rawKey), keyMask: userAiProviderVaultTestHooks.maskKey(rawKey), model: "openai/gpt-4o-mini", updatedAt: "2026-01-01T00:00:00.000Z" })).toBe(rawKey);
    expect(userAiProviderVaultTestHooks.maskKey(rawKey)).not.toBe(rawKey);
    expect(userAiProviderVaultTestHooks.fingerprint(rawKey)).not.toContain(rawKey);
  });

  it("derives a separate vault key from the server-only Supabase service role secret when no dedicated vault secret is set", () => {
    delete process.env.AI_KEY_ENCRYPTION_SECRET;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-server-only-service-role-secret";
    const rawKey = "test-provider-key-01234567890";
    const sealed = userAiProviderVaultTestHooks.encrypt(rawKey);
    expect(JSON.stringify(sealed)).not.toContain(rawKey);
    expect(userAiProviderVaultTestHooks.decrypt({ userId: 1, ...sealed, keyFingerprint: userAiProviderVaultTestHooks.fingerprint(rawKey), keyMask: userAiProviderVaultTestHooks.maskKey(rawKey), model: "openai/gpt-4o-mini", updatedAt: "2026-01-01T00:00:00.000Z" })).toBe(rawKey);
  });

  it("refuses encryption when no server-only secret is available", () => {
    delete process.env.AI_KEY_ENCRYPTION_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => userAiProviderVaultTestHooks.encrypt("test-provider-key-01234567890")).toThrow("secure AI key vault is unavailable");
  });
});
