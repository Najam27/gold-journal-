import type { InsertUser } from "../drizzle/schema";
import { getSupabaseAdmin } from "./supabaseAdmin";

export async function upsertUser(user: InsertUser) {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const values: Record<string, unknown> = { openId: user.openId, lastSignedIn: user.lastSignedIn ?? new Date() };
  for (const field of ["name", "email", "loginMethod", "role"] as const) if (user[field] !== undefined) values[field] = user[field] ?? null;
  const { data, error } = await getSupabaseAdmin().from("users").upsert(values, { onConflict: "openId" }).select("*").single();
  if (error || !data) throw new Error(`Supabase user upsert failed: ${error?.message || "empty user"}`);
  return data;
}

export async function getUserByOpenId(openId: string) {
  const { data, error } = await getSupabaseAdmin().from("users").select("*").eq("openId", openId).maybeSingle();
  if (error) throw new Error(`Supabase user lookup failed: ${error.message}`);
  return data ?? undefined;
}
