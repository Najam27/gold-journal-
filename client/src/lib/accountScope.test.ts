import { describe, expect, it, vi } from "vitest";
import { invalidateAccountScopedQueries, resolveActiveAccount } from "./accountScope";

describe("resolveActiveAccount", () => {
  const accounts = [
    { id: 1, name: "Primary" },
    { id: 2, name: "Funded" },
  ];

  it("survives a cold start where the selection and the payload are both unknown", () => {
    // This exact combination crashed the dashboard: undefined === undefined
    // matched and then read a property off an undefined payload.
    expect(resolveActiveAccount(undefined, undefined, undefined)).toBeUndefined();
    expect(resolveActiveAccount(null, [], undefined)).toBeUndefined();
    expect(resolveActiveAccount(undefined, [], 3)).toBeUndefined();
  });

  it("keeps the user's selection while the previous account payload is still cached", () => {
    expect(resolveActiveAccount({ id: 1, name: "Primary" }, accounts, 2)).toMatchObject({ id: 2, name: "Funded" });
  });

  it("trusts a matching server payload and prefers it over the summary list", () => {
    expect(resolveActiveAccount({ id: 2, name: "Funded live" }, accounts, 2)).toMatchObject({ name: "Funded live" });
  });

  it("falls back to the payload when the owned-account list has not loaded yet", () => {
    expect(resolveActiveAccount({ id: 7, name: "Restored" }, [], 7)).toMatchObject({ id: 7 });
  });
});

describe("account-scoped query invalidation", () => {
  it("does not turn a missing or rejected optional invalidation into a mutation failure", async () => {
    const rejected = vi.fn().mockRejectedValue(new Error("stale proxy"));
    await expect(invalidateAccountScopedQueries({ journal: { get: { invalidate: rejected } }, trades: { list: { invalidate: vi.fn() } }, mt5: { workspace: { invalidate: vi.fn() }, history: { invalidate: vi.fn() } } })).resolves.toHaveLength(5);
  });

  it("invalidates journal, paginated trades, MT5 workspace/history, notifications, and option lists", async () => {
    const invalidations = Array.from({ length: 7 }, () => vi.fn().mockResolvedValue(undefined));
    const utils = {
      journal: { get: { invalidate: invalidations[0] } },
      trades: { list: { invalidate: invalidations[1] } },
      mt5: { workspace: { invalidate: invalidations[2] }, history: { invalidate: invalidations[3] } },
      notifications: { get: { invalidate: invalidations[4] } },
      analysis: { get: { invalidate: invalidations[5] } },
      optionLists: { list: { invalidate: invalidations[6] } },
    };

    await invalidateAccountScopedQueries(utils);

    expect(invalidations.every(fn => fn.mock.calls.length === 1)).toBe(true);
  });
});
