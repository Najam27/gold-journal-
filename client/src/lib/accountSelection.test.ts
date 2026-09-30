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

  it("persists the selection in localStorage so it survives a browser restart", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };
    (globalThis as any).window = { localStorage: storage, sessionStorage: storage };

    setSelectedAccountId(42);
    expect(store.get("gj_active_account_id")).toBe("42");
    setSelectedAccountId(undefined);
    expect(store.has("gj_active_account_id")).toBe(false);

    delete (globalThis as any).window;
  });
});
