import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  beginAccountSwitch,
  isAccountScopedQueryKey,
  payloadBelongsToAccount,
  queryInputAccountId,
  queryKeyAccountId,
} from "./accountScope";

const journalKey = (accountId: number) =>
  [["journal", "get"], { input: { accountId }, type: "query" }] as const;
const tradesKey = (accountId: number) =>
  [["trades", "list"], { input: { accountId, page: 1 }, type: "query" }] as const;

function seed(client: QueryClient, accountId: number) {
  client.setQueryData(journalKey(accountId) as unknown as readonly unknown[], {
    activeAccount: { id: accountId },
    trades: [{ id: accountId }],
  });
  client.setQueryData(tradesKey(accountId) as unknown as readonly unknown[], {
    trades: [{ id: accountId }],
  });
}

describe("account-scoped query keys", () => {
  it("recognizes account-scoped procedures and reads their account id", () => {
    expect(isAccountScopedQueryKey(journalKey(5) as unknown as readonly unknown[])).toBe(true);
    expect(isAccountScopedQueryKey([["accounts", "list"], { input: undefined }])).toBe(false);
    expect(isAccountScopedQueryKey([["optionLists", "list"], { input: undefined }])).toBe(false);
    expect(queryKeyAccountId(journalKey(5) as unknown as readonly unknown[])).toBe(5);
    expect(queryKeyAccountId([["accounts", "list"], { input: undefined }])).toBeUndefined();
  });

  it("reads a nested account id (analysis.compare keeps one per side)", () => {
    expect(queryInputAccountId({ current: { accountId: 7 }, previous: { accountId: 8 } })).toBe(7);
    expect(queryInputAccountId({ accountId: "12" })).toBe(12);
    expect(queryInputAccountId({ accountId: 0 })).toBeUndefined();
    expect(queryInputAccountId(null)).toBeUndefined();
  });
});

describe("beginAccountSwitch", () => {
  it("drops the previous account's cached payloads and keeps the target account's", async () => {
    const client = new QueryClient();
    seed(client, 5);
    seed(client, 9);
    client.setQueryData(
      [["analysis", "compare"], { input: { current: { accountId: 5 }, previous: { accountId: 5 } }, type: "query" }],
      { current: {} }
    );

    const result = await beginAccountSwitch(client, 9);

    expect(result.removed).toBe(3);
    expect(client.getQueryData(journalKey(5) as unknown as readonly unknown[])).toBeUndefined();
    expect(client.getQueryData(tradesKey(5) as unknown as readonly unknown[])).toBeUndefined();
    expect(client.getQueryData(journalKey(9) as unknown as readonly unknown[])).toBeDefined();
    expect(client.getQueryData(tradesKey(9) as unknown as readonly unknown[])).toBeDefined();
  });

  it("cancels in-flight account-scoped requests so a late response cannot land", async () => {
    const client = new QueryClient();
    const pending = client.fetchQuery({
      queryKey: journalKey(5) as unknown as readonly unknown[],
      queryFn: () => new Promise(() => undefined),
    });

    const result = await beginAccountSwitch(client, 9);

    expect(result.canceled).toBeGreaterThan(0);
    await expect(pending).rejects.toBeTruthy();
  });

  it("is a no-op without a target account", async () => {
    const client = new QueryClient();
    seed(client, 5);
    await expect(beginAccountSwitch(client, undefined)).resolves.toEqual({ canceled: 0, removed: 0 });
    expect(client.getQueryData(journalKey(5) as unknown as readonly unknown[])).toBeDefined();
  });
});

describe("payloadBelongsToAccount", () => {
  it("rejects a payload that still belongs to the previous account", () => {
    expect(payloadBelongsToAccount({ activeAccount: { id: 5 } }, 9)).toBe(false);
    expect(payloadBelongsToAccount({ activeAccount: { id: "9" } }, 9)).toBe(true);
  });

  it("accepts payloads that carry no account identity", () => {
    expect(payloadBelongsToAccount({ trades: [] }, 9)).toBe(true);
    expect(payloadBelongsToAccount(null, 9)).toBe(true);
    expect(payloadBelongsToAccount({ activeAccount: { id: 5 } }, undefined)).toBe(true);
  });
});
