import { describe, expect, it, vi } from "vitest";
import { invalidateAccountScopedQueries } from "./accountScope";

describe("account-scoped query invalidation", () => {
  it("invalidates journal, paginated trades, MT5 workspace/history, notifications, and option lists", async () => {
    const invalidations = Array.from({ length: 6 }, () => vi.fn().mockResolvedValue(undefined));
    const utils = {
      journal: { get: { invalidate: invalidations[0] } },
      trades: { list: { invalidate: invalidations[1] } },
      mt5: { workspace: { invalidate: invalidations[2] }, history: { invalidate: invalidations[3] } },
      notifications: { get: { invalidate: invalidations[4] } },
      optionLists: { list: { invalidate: invalidations[5] } },
    };

    await invalidateAccountScopedQueries(utils);

    expect(invalidations.every(fn => fn.mock.calls.length === 1)).toBe(true);
  });
});
