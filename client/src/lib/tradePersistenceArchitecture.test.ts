import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The trade persistence contract.
 *
 * Gold Journal used to be local-first: the browser kept a durable IndexedDB copy
 * of the journal plus a queue of pending trade mutations, and replayed it into
 * the backend later. Trades could therefore pile up locally while cloud
 * synchronisation failed.
 *
 * The contract now is a single, direct path:
 *
 *     Trade Dialog -> tRPC -> Supabase -> canonical trade -> refetch
 *
 * These tests read the repository itself, so a future change that reintroduces a
 * local trade store, or that hides a second save path beside the direct one,
 * fails here rather than in production.
 */

const root = process.cwd();
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

/** Every source file under `dir` (no tests, no build output). */
function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(resolve(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(resolve(root, rel)).isDirectory()) found.push(...sources(rel));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(rel);
  }
  return found;
}

describe("trade persistence architecture", () => {
  it("has no local-first trade store left anywhere in the repository", () => {
    for (const removed of [
      "client/src/lib/journal/journalStore.ts",
      "client/src/lib/journal/journalSync.ts",
      "client/src/lib/journal/useLocalJournal.ts",
      "client/src/lib/offlineMutationQueue.ts",
    ]) {
      expect(existsSync(resolve(root, removed)), `${removed} must be deleted`).toBe(false);
    }
  });

  it("keeps exactly one trade save path: frontend -> tRPC -> Supabase", () => {
    const page = read("client/src/pages/GoldJournal.tsx");

    // Create/update/delete/list are the tRPC trade mutations, called directly.
    expect(page).toMatch(/trpc\.trades\.create\.useMutation\(\)/);
    expect(page).toMatch(/trpc\.trades\.update\.useMutation\(\)/);
    expect(page).toMatch(/trpc\.trades\.delete\.useMutation\(\)/);
    expect(page).toMatch(/trpc\.trades\.list\.useQuery\(/);
    expect(page).toMatch(/await createTrade\.mutateAsync\(tradePayload as any\)/);
    expect(page).toMatch(/await updateTrade\.mutateAsync\(/);
    expect(page).toMatch(/await deleteTrade\.mutateAsync\(\{ tradeId \}\)/);
    expect(page).toMatch(/await refreshCurrentAccount\(utils\)/);
  });

  it("leaves no queued, optimistic, or snapshot trade path in any source file", () => {
    const forbidden = [
      "enqueueJournalMutation",
      "flushJournalMutations",
      "pendingJournalMutations",
      "queuedJournalMutationCount",
      "readJournalSnapshot",
      "saveJournalSnapshot",
      "applyMutationToJournal",
      "reconcileCanonicalTrade",
      "useLocalJournal",
      "journalSync",
      "journalStore",
      "offlineMutationQueue",
      "localPending: true",
    ];
    const offenders: string[] = [];
    for (const file of [...sources("client/src"), ...sources("server"), ...sources("shared"), ...sources("worker")]) {
      const text = read(file);
      for (const needle of forbidden) {
        if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never reads trades back out of browser storage", () => {
    const page = read("client/src/pages/GoldJournal.tsx");
    // The page may remember UI chrome (the sidebar rail), never journal data.
    expect(page).toMatch(/window\.localStorage\.getItem\("gj:sidebar-rail"\)/);
    expect(page).not.toMatch(/indexedDB/i);
    expect(page).not.toMatch(/localStorage\.(get|set)Item\([^)]*(trade|journal)/i);
  });

  it("keeps the legitimate local storage that is not a trade store", () => {
    // UI preferences and the AI credential are explicitly out of scope.
    expect(existsSync(resolve(root, "client/src/lib/ai/aiStorage.ts"))).toBe(true);
    expect(read("client/src/lib/ai/aiStorage.ts")).toContain("localStorage");
    expect(read("client/src/components/DashboardLayout.tsx")).toContain("localStorage");
  });

  it("cleans the removed local journal store without re-uploading it", () => {
    const cleanup = read("client/src/lib/journal/legacyLocalJournalCleanup.ts");
    expect(cleanup).toContain("deleteDatabase");
    expect(cleanup).toContain('LEGACY_JOURNAL_DB_NAME = "gold-journal"');
    // Cleanup must never push local trades into the backend.
    expect(cleanup).not.toMatch(/trpc|fetch\(|insert/i);
  });

  it("keeps the backend the only writer, with account-scoped ownership checks", () => {
    const router = read("server/goldRouter.ts");
    // Ownership is proven before every trade write.
    expect(router).toMatch(/create: protectedProcedure[\s\S]*?await getOwnedAccount\(ctx\.user\.id, input\.accountId\)/);
    expect(router).toMatch(/update: protectedProcedure[\s\S]*?resolveOwnedTradeForMutation\(ctx\.user\.id, input\)/);
    expect(router).toMatch(/delete: protectedProcedure[\s\S]*?eq\(trades\.userId, ctx\.user\.id\)/);
    // Server-side idempotency for a retried save is retained (the unique
    // (userId, accountId, clientMutationId) index is not dropped).
    expect(router).toContain("input.clientMutationId");
  });
});
