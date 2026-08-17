import { describe, expect, it } from "vitest";
import { getSelectedAccountId, setSelectedAccountId, subscribeSelectedAccount } from "./accountSelection";

describe("selected account client state", () => {
  it("updates rename consumers to the newly selected account after a switch", () => {
    const observed: Array<number | undefined> = [];
    const unsubscribe = subscribeSelectedAccount(accountId => observed.push(accountId));

    setSelectedAccountId(12);
    setSelectedAccountId(24);

    expect(getSelectedAccountId()).toBe(24);
    expect(observed).toEqual([12, 24]);
    unsubscribe();
  });
});
