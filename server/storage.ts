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

export function hasImageSignature(bytes: Uint8Array, mimeType: "image/jpeg" | "image/png" | "image/webp") {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

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
