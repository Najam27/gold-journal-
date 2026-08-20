import { clearOfflineMutation, enqueueOfflineMutation, queuedMutations, replayOfflineMutations } from "./offlineMutationQueue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("offline mutation queue", () => {
  let values = new Map<string, string>();
  beforeEach(() => { values = new Map(); vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() }); vi.stubGlobal("window", { dispatchEvent: vi.fn() }); vi.stubGlobal("navigator", { onLine: true }); });
  afterEach(() => vi.unstubAllGlobals());
  it("scopes queued items to the signed-in user and active account", () => {
    enqueueOfflineMutation({ id: "a".repeat(16), subject: "user-a", accountId: 1, kind: "trade.create", payload: { accountId: 1 } });
    enqueueOfflineMutation({ id: "b".repeat(16), subject: "user-b", accountId: 1, kind: "cash.create", payload: { accountId: 1 } });
    expect(queuedMutations("user-a", 1)).toHaveLength(1); expect(queuedMutations("user-a", 2)).toHaveLength(0);
  });
  it("replays in queue order and keeps a failed item for a later retry", async () => {
    enqueueOfflineMutation({ id: "a".repeat(16), subject: "user-a", accountId: 1, kind: "trade.create", payload: { accountId: 1 } });
    enqueueOfflineMutation({ id: "b".repeat(16), subject: "user-a", accountId: 1, kind: "cash.create", payload: { accountId: 1 } });
    const seen: string[] = []; const result = await replayOfflineMutations("user-a", 1, async item => { seen.push(item.kind); if (item.kind === "cash.create") throw new Error("offline"); });
    expect(seen).toEqual(["trade.create", "cash.create"]); expect(result.replayed).toBe(1); expect(result.failed).toBe(true); expect(queuedMutations("user-a", 1).map(item => item.kind)).toEqual(["cash.create"]);
    clearOfflineMutation("b".repeat(16)); expect(queuedMutations("user-a", 1)).toHaveLength(0);
  });
});
