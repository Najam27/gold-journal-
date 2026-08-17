import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient();

/**
 * tRPC query keys are not tenant identifiers. Clear the in-memory cache when
 * the Supabase identity changes so a later user cannot observe prior data.
 */
export function clearPrivateClientState() {
  void queryClient.cancelQueries().catch(() => undefined);
  queryClient.clear();
}
