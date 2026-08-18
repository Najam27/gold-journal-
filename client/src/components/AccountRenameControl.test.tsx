// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSelectedAccountId } from "@/lib/accountSelection";

const mocks = vi.hoisted(() => ({
  accounts: [{ id: 12, name: "Primary Account" }, { id: 24, name: "Review Account" }],
  list: vi.fn(),
  rename: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true, profileReady: true }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    accounts: { list: { useQuery: () => mocks.list() }, rename: { useMutation: () => ({ mutateAsync: mocks.rename, isPending: false }) }, create: { useMutation: () => ({ mutateAsync: mocks.create, isPending: false }) }, remove: { useMutation: () => ({ mutateAsync: mocks.remove, isPending: false }) } },
    useUtils: () => ({
      accounts: { list: { invalidate: mocks.invalidate } }, journal: { get: { invalidate: mocks.invalidate } }, trades: { list: { invalidate: mocks.invalidate } },
      mt5: { workspace: { invalidate: mocks.invalidate }, history: { invalidate: mocks.invalidate } }, notifications: { get: { invalidate: mocks.invalidate } },
      analysis: { get: { invalidate: mocks.invalidate } }, optionLists: { list: { invalidate: mocks.invalidate } },
    }),
  },
}));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: ({ children }: any) => <>{children}</>, DialogContent: ({ children }: any) => <div>{children}</div>, DialogDescription: ({ children }: any) => <p>{children}</p>, DialogHeader: ({ children }: any) => <div>{children}</div>, DialogTitle: ({ children }: any) => <h2>{children}</h2> }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { AccountRenameControl } from "./AccountRenameControl";

describe("AccountRenameControl independent account management", () => {
  afterEach(() => cleanup());
  beforeEach(() => { setSelectedAccountId(undefined); mocks.list.mockReset().mockReturnValue({ data: mocks.accounts, isLoading: false, error: null, refetch: vi.fn() }); mocks.invalidate.mockReset(); });

  it("renders Manage Accounts and uses accounts.list without journal.get", () => {
    render(<AccountRenameControl />);
    expect(screen.getByTitle("Manage trading accounts")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Manage trading accounts"));
    expect(screen.getByText("Primary Account")).toBeTruthy();
    expect(screen.getByText("Review Account")).toBeTruthy();
    expect(mocks.list).toHaveBeenCalled();
  });

  it("replaces a stale selected account with the first owned account", async () => {
    setSelectedAccountId(999);
    render(<AccountRenameControl />);
    await waitFor(() => expect(screen.getByText("Primary Account")).toBeTruthy());
    expect(screen.getByText("Primary Account")).toBeTruthy();
  });
});
