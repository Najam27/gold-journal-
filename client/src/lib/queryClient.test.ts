import { afterEach, describe, expect, it } from "vitest";
import { clearPrivateClientState, queryClient } from "./queryClient";

describe("private query cache isolation", () => {
  afterEach(() => clearPrivateClientState());

  it("removes user A data before a later user B session can reuse the cache", () => {
    queryClient.setQueryData(["journal", "user-a"], { trades: [{ id: 41, notes: "private A" }] });
    queryClient.setQueryData(["journal", "user-b"], { trades: [] });
    clearPrivateClientState();
    expect(queryClient.getQueryData(["journal", "user-a"])).toBeUndefined();
    expect(queryClient.getQueryData(["journal", "user-b"])).toBeUndefined();
  });
});
