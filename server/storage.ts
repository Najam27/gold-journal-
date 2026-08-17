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
function appendHashSuffix(value: string) { const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8); const dot = value.lastIndexOf("."); return dot < 0 ? `${value}_${hash}` : `${value.slice(0, dot)}_${hash}${value.slice(dot)}`; }

export async function storagePut(relKey: string, data: Buffer | Uint8Array | string, contentType = "application/octet-stream") {
  const key = appendHashSuffix(normalizeKey(relKey));
  const { error } = await client().storage.from(bucket).upload(key, typeof data === "string" ? Buffer.from(data) : Buffer.from(data), { contentType, upsert: false });
  if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);
  return { key, url: await storageGetSignedUrl(key) };
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
