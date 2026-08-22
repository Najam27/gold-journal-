import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getSupabaseAdmin } from "./supabaseAdmin";

type StoredSetting = { userId: number; keyCiphertext: string; keyIv: string; keyAuthTag: string; keyFingerprint: string; keyMask: string; model: string; updatedAt: string };
export type UserAiCredential = { key: string; model: string };

function masterKey() {
  const secret = process.env.AI_KEY_ENCRYPTION_SECRET?.trim();
  if (!secret) throw new Error("The secure AI key vault is unavailable. Configure AI_KEY_ENCRYPTION_SECRET on the server, then retry.");
  return createHash("sha256").update(secret, "utf8").digest();
}
function vaultAvailable() { return Boolean(process.env.AI_KEY_ENCRYPTION_SECRET?.trim()); }
function maskKey(key: string) { return `${key.slice(0, 7)}••••${key.slice(-4)}`; }
function fingerprint(key: string) { return createHash("sha256").update(key, "utf8").digest("hex"); }
function encrypt(key: string) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", masterKey(), iv); const ciphertext = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return { keyCiphertext: ciphertext.toString("base64url"), keyIv: iv.toString("base64url"), keyAuthTag: cipher.getAuthTag().toString("base64url") };
}
function decrypt(row: StoredSetting) {
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(row.keyIv, "base64url")); decipher.setAuthTag(Buffer.from(row.keyAuthTag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(row.keyCiphertext, "base64url")), decipher.final()]).toString("utf8");
}
async function setting(userId: number) {
  const { data, error } = await getSupabaseAdmin().from("gj_ai_provider_settings").select("userId,keyCiphertext,keyIv,keyAuthTag,keyFingerprint,keyMask,model,updatedAt").eq("userId", userId).maybeSingle();
  if (error) throw new Error("Unable to load AI provider settings.");
  return data as StoredSetting | null;
}
export async function getUserAiProviderStatus(userId: number) { const row = await setting(userId); const available = vaultAvailable(); return row ? { configured: true, vaultAvailable: available, model: row.model, maskedKey: row.keyMask, updatedAt: row.updatedAt } : { configured: false, vaultAvailable: available, model: null, maskedKey: null, updatedAt: null }; }
export async function getUserAiCredential(userId: number): Promise<UserAiCredential | null> { const row = await setting(userId); if (!row) return null; try { return { key: decrypt(row), model: row.model }; } catch { throw new Error("Your saved AI key could not be unlocked. Replace it in Options."); } }
export async function saveUserAiCredential(userId: number, key: string, model: string) {
  const cleanKey = key.trim(); const cleanModel = model.trim(); if (cleanKey.length < 20 || cleanKey.length > 512) throw new Error("Enter a valid OpenRouter API key."); if (!cleanModel || cleanModel.length > 160) throw new Error("Enter a valid OpenRouter model name.");
  const sealed = encrypt(cleanKey); const row = { userId, ...sealed, keyFingerprint: fingerprint(cleanKey), keyMask: maskKey(cleanKey), model: cleanModel, updatedAt: new Date().toISOString() };
  const { error } = await getSupabaseAdmin().from("gj_ai_provider_settings").upsert(row, { onConflict: "userId" }); if (error) throw new Error("Unable to save your encrypted AI key.");
  return getUserAiProviderStatus(userId);
}
export async function deleteUserAiCredential(userId: number) { const { error } = await getSupabaseAdmin().from("gj_ai_provider_settings").delete().eq("userId", userId); if (error) throw new Error("Unable to delete your AI key."); return { configured: false }; }
export async function testUserAiCredential(key: string) {
  const response = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key.trim()}` }, signal: AbortSignal.timeout(12_000) }); if (!response.ok) throw new Error("OpenRouter rejected this API key.");
  const body = await response.json().catch(() => null) as { data?: { label?: string; is_free_tier?: boolean; limit_remaining?: number | null } } | null; return { valid: true, label: body?.data?.label?.slice(0, 40) ?? "OpenRouter key", freeTier: Boolean(body?.data?.is_free_tier), limitRemaining: body?.data?.limit_remaining ?? null };
}
export const userAiProviderVaultTestHooks = { encrypt, decrypt, maskKey, fingerprint };
