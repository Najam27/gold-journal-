import { describe, expect, it, vi } from "vitest";
import { invalidateAccountScopedQueries } from "./accountScope";

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
