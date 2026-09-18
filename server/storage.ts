import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "./supabaseAdmin";

const bucket = process.env.SUPABASE_STORAGE_BUCKET || "trade-screenshots";
function client() { return getSupabaseAdmin(); }
function normalizeKey(value: string) {
  const key = value.replace(/^\/+/, "");
  if (!key || key.includes("\\") || key.includes("..") || key.includes("\u0000") || /[\u0000-\u001f\u007f]/.test(key)) throw new Error("Invalid private storage path.");
  const segments = key.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment.length > 255)) throw new Error("Invalid private storage path.");
  return segments.join("/");
}
function appendHashSuffix(value: string) { const hash = randomUUID().replace(/-/g, "").slice(0, 8); const dot = value.lastIndexOf("."); return dot < 0 ? `${value}_${hash}` : `${value.slice(0, dot)}_${hash}${value.slice(dot)}`; }

export function hasImageSignature(bytes: Uint8Array, mimeType: "image/jpeg" | "image/png" | "image/webp") {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

/* ------------------------------------------------------------------ *
 * Trade Log screenshot storage contract
 * ------------------------------------------------------------------ *
 *
 * Object keys are `{authUid}/accounts/{accountId}/trades/{tradeRef}/{file}`.
 *
 * The leading segment MUST be the Supabase auth uid (the account's `openId`)
 * because the bucket policies authorize on
 * `public.owns_screenshot_folder((storage.foldername(name))[1])` — see
 * supabase/migrations/0002_security_rls_and_storage.sql. The previous key
 * (`gold-journal/{openId}/trades/...`) put a constant in that first segment, so
 * every stored object was outside the policy's ownership rule and only worked
 * because the server happens to hold the service role.
 *
 * The account segment is what keeps one journal account's evidence out of
 * another account's reach, and the database stores this stable key forever.
 * Signed URLs are minted on read and are NEVER persisted.
 */

export function screenshotPathPrefix(authUid: string, accountId: number) {
  return `${authUid}/accounts/${accountId}/trades/`;
}

/** True only for a well-formed key that is inside this identity AND account. */
export function isOwnedScreenshotPath(key: unknown, authUid: string | null | undefined, accountId: number | null | undefined): boolean {
  if (!authUid || typeof authUid !== "string" || !authUid.trim()) return false;
  if (!Number.isInteger(accountId) || Number(accountId) <= 0) return false;
  if (typeof key !== "string" || key.length === 0 || key.length > 500) return false;
  if (!key.startsWith(screenshotPathPrefix(authUid, Number(accountId)))) return false;
  try {
    normalizeKey(key);
  } catch {
    return false;
  }
  return true;
}

/**
 * Rejects a client-supplied `screenshotKey` that points outside the caller's own
 * account folder, so a trade can never adopt (and later display) another user's
 * or another account's object.
 */
export function assertOwnedScreenshotPath(key: string, authUid: string | null | undefined, accountId: number) {
  if (!isOwnedScreenshotPath(key, authUid, accountId)) throw new Error("That screenshot reference does not belong to this account.");
  return key;
}

/** Builds a unique, policy-compliant key. `tradeRef` is a trade id or a mutation id. */
export function screenshotObjectKey(input: { authUid: string; accountId: number; tradeRef: string | number; extension: string; draft?: boolean }) {
  const folder = input.draft ? `draft-${String(input.tradeRef)}` : String(input.tradeRef);
  return normalizeKey(`${screenshotPathPrefix(input.authUid, input.accountId)}${folder}/${randomUUID().replace(/-/g, "")}.${input.extension}`);
}

/** Uploads at an exact key. The caller is responsible for key uniqueness. */
export async function storagePutAt(relKey: string, data: Buffer | Uint8Array | string, contentType = "application/octet-stream") {
  const key = normalizeKey(relKey);
  const { error } = await client().storage.from(bucket).upload(key, typeof data === "string" ? Buffer.from(data) : Buffer.from(data), { contentType, upsert: false });
  if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);
  return { key, url: await storageGetSignedUrl(key) };
}

/** Uploads with a hash suffix appended, so the stored name can never collide. */
export async function storagePut(relKey: string, data: Buffer | Uint8Array | string, contentType = "application/octet-stream") {
  return storagePutAt(appendHashSuffix(normalizeKey(relKey)), data, contentType);
}

/**
 * Best-effort object removal for superseded or deleted screenshots.
 *
 * Cleanup must never fail the journal write that triggered it: an orphaned
 * object is harmless, a lost trade is not. The boolean is informational only.
 */
export async function storageRemove(relKey: string | null | undefined): Promise<boolean> {
  if (!relKey) return false;
  try {
    const key = normalizeKey(relKey);
    const { error } = await client().storage.from(bucket).remove([key]);
    return !error;
  } catch {
    return false;
  }
}

/** Supabase Storage rejects a single remove() beyond 1,000 keys. */
export const STORAGE_REMOVE_CHUNK = 100;

/**
 * Best-effort removal of many objects, for the account-wide destructive paths.
 *
 * `gj_clear_account_journal_data` and `gj_remove_account` delete the rows that
 * referenced these objects, which would otherwise leave the images readable in
 * the private bucket forever. Every failure is swallowed and only counted: an
 * orphaned object is a leak, but failing the caller's destructive request over
 * it would be worse.
 */
export async function storageRemoveMany(relKeys: Array<string | null | undefined>): Promise<number> {
  const keys = relKeys.filter((key): key is string => typeof key === "string" && key.length > 0);
  if (!keys.length) return 0;
  let removed = 0;
  for (let index = 0; index < keys.length; index += STORAGE_REMOVE_CHUNK) {
    try {
      const chunk = keys.slice(index, index + STORAGE_REMOVE_CHUNK).map(key => normalizeKey(key));
      const { error } = await client().storage.from(bucket).remove(chunk);
      if (!error) removed += chunk.length;
    } catch {
      // ignore: see the function doc above
    }
  }
  return removed;
}

export async function storageGet(relKey: string) {
  const key = normalizeKey(relKey);
  return { key, url: await storageGetSignedUrl(key) };
}

export async function storageGetSignedUrl(relKey: string) {
  const key = normalizeKey(relKey);
  const { data, error } = await client().storage.from(bucket).createSignedUrl(key, 60 * 60);
  if (error || !data?.signedUrl) throw new Error(`Supabase Storage signed URL failed: ${error?.message || "empty URL"}`);
  return data.signedUrl;
}
