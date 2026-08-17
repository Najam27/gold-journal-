import { getUserByOpenId, upsertUser } from "./db";
import { getSupabaseAdmin } from "./supabaseAdmin";

export { getSupabaseAdmin } from "./supabaseAdmin";

export async function authenticateSupabaseAccessToken(token: string) {
  const { data, error } = await getSupabaseAdmin().auth.getUser(token);
  if (error || !data.user) return null;
  const authUser = data.user;
  const name = (authUser.user_metadata?.full_name || authUser.user_metadata?.name || authUser.email?.split("@")[0] || "Gold Trader") as string;
  const existing = await getUserByOpenId(authUser.id);
  await upsertUser({ openId: authUser.id, name, email: authUser.email ?? null, loginMethod: "supabase", lastSignedIn: new Date() });
  return (await getUserByOpenId(authUser.id)) || existing || null;
}
