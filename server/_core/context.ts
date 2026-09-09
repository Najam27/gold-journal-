import type { User } from "../../drizzle/schema";
import { authenticateSupabaseAccessToken } from "../supabase";

/**
 * Minimal request shape shared by the Express dev adapter and the Cloudflare
 * Workers fetch adapter. Only the Authorization header is consumed.
 */
export type AuthHeaderSource = {
  headers: { authorization?: string | undefined } | { get(name: string): string | null };
};

export type TrpcContext = {
  req: AuthHeaderSource & Record<string, unknown>;
  res: unknown;
  user: User | null;
  authError?: Error | null;
};

export function readAuthorizationHeader(source: AuthHeaderSource): string | undefined {
  const headers = source.headers as { authorization?: string | undefined; get?: (name: string) => string | null };
  if (typeof headers.get === "function") return headers.get("authorization")?.trim() || undefined;
  return headers.authorization?.trim() || undefined;
}

export async function buildUserContext(authorization: string | undefined): Promise<{ user: User | null; authError: Error | null }> {
  let user: User | null = null;
  let authError: Error | null = null;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    try {
      user = await authenticateSupabaseAccessToken(authorization.slice(7));
    } catch (error) {
      authError = error instanceof Error ? error : new Error("Secure session verification failed.");
      console.warn("[Auth] token verification failed", authError.message);
    }
  }
  return { user, authError };
}

/**
 * Express adapter context (used by the local `pnpm dev` server). The Workers
 * entry point builds the same context from a fetch Request.
 */
export async function createContext(opts: { req: AuthHeaderSource; res: unknown }): Promise<TrpcContext> {
  const { user, authError } = await buildUserContext(readAuthorizationHeader(opts.req));
  return { req: opts.req as TrpcContext["req"], res: opts.res, user, authError };
}
