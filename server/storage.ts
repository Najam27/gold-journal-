import { createClient } from "@supabase/supabase-js";
import { ENV } from "./_core/env";

const bucket = process.env.SUPABASE_STORAGE_BUCKET || "trade-screenshots";
function client() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase Storage config missing: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}
function normalizeKey(value: string) { return value.replace(/^\/+/, ""); }
function appendHashSuffix(value: string) { const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8); const dot = value.lastIndexOf("."); return dot < 0 ? `${value}_${hash}` : `${value.slice(0, dot)}_${hash}${value.slice(dot)}`; }

export async function storagePut(relKey: string, data: Buffer | Uint8Array | string, contentType = "application/octet-stream") {
  const key = appendHashSuffix(normalizeKey(relKey));
  const { error } = await client().storage.from(bucket).upload(key, typeof data === "string" ? Buffer.from(data) : Buffer.from(data), { contentType, upsert: false });
  if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);
  return { key, url: `/storage/${bucket}/${key}` };
}

export async function storageGet(relKey: string) { const key = normalizeKey(relKey); return { key, url: `/storage/${bucket}/${key}` }; }

export async function storageGetSignedUrl(relKey: string) {
  const key = normalizeKey(relKey);
  const { data, error } = await client().storage.from(bucket).createSignedUrl(key, 60 * 60);
  if (error || !data?.signedUrl) throw new Error(`Supabase Storage signed URL failed: ${error?.message || "empty URL"}`);
  return data.signedUrl;
}
