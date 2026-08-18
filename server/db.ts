import { supabaseDb } from "./supabaseQuery";

export { getUserByOpenId, upsertUser } from "./userDb";

export async function getDb() {
  return supabaseDb;
}
