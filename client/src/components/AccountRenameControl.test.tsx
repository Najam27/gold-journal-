// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSelectedAccountId } from "@/lib/accountSelection";

const mocks = vi.hoisted(() => ({
  queryInputs: [] as Array<{ accountId?: number }>,
  rename: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    journal: { get: { useQuery: (input: { accountId?: number }) => { mocks.queryInputs.push(input); return { data: { activeAccount: { id: input.accountId, name: `Account ${input.accountId}` } } }; } } },
    accounts: { rename: { useMutation: () => ({ mutateAsync: mocks.rename, isPending: false }) }, create: { useMutation: () => ({ mutateAsync: mocks.create, isPending: false }) }, remove: { useMutation: () => ({ mutateAsync: mocks.remove, isPending: false }) } },
    useUtils: () => ({ journal: { get: { invalidate: mocks.invalidate } } }),
  },
}));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: ({ children }: any) => <>{children}</>, DialogContent: ({ children }: any) => <div>{children}</div>, DialogDescription: ({ children }: any) => <p>{children}</p>, DialogHeader: ({ children }: any) => <div>{children}</div>, DialogTitle: ({ children }: any) => <h2>{children}</h2> }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { AccountRenameControl } from "./AccountRenameControl";

describe("AccountRenameControl selected-account integration", () => {
  beforeEach(() => { mocks.queryInputs.length = 0; setSelectedAccountId(undefined); });

  it("switches the rename query target when the selected account changes", async () => {
    setSelectedAccountId(12);
    render(<AccountRenameControl />);
    expect(mocks.queryInputs.at(-1)).toEqual({ accountId: 12 });

    await act(async () => { setSelectedAccountId(24); });
    await waitFor(() => expect(mocks.queryInputs.at(-1)).toEqual({ accountId: 24 }));
  });
});
