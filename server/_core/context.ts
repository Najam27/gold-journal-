import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { authenticateSupabaseAccessToken } from "../supabase";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  authError?: Error | null;
};

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  let user: User | null = null;
  let authError: Error | null = null;
  const header = opts.req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    try { user = await authenticateSupabaseAccessToken(header.slice(7)); } catch (error) { authError = error instanceof Error ? error : new Error("Secure session verification failed."); console.warn("[Auth] token verification failed", authError.message); }
  }
  return { req: opts.req, res: opts.res, user, authError };
}
