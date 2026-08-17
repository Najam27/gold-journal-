import type { InsertUser } from "../drizzle/schema";
import { getSupabaseAdmin } from "./supabase";
import { supabaseDb } from "./supabaseQuery";

export async function getDb() {
  return supabaseDb;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const values: Record<string, unknown> = { openId: user.openId, lastSignedIn: user.lastSignedIn ?? new Date() };
  for (const field of ["name", "email", "loginMethod", "role"] as const) if (user[field] !== undefined) values[field] = user[field] ?? null;
  const { error } = await getSupabaseAdmin().from("users").upsert(values, { onConflict: "openId" });
  if (error) throw new Error(`Supabase user upsert failed: ${error.message}`);
}

export async function getUserByOpenId(openId: string) {
  const { data, error } = await getSupabaseAdmin().from("users").select("*").eq("openId", openId).maybeSingle();
  if (error) throw new Error(`Supabase user lookup failed: ${error.message}`);
  return data ?? undefined;
}
