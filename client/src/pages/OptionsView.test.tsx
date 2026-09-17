// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ add: vi.fn(), rename: vi.fn(), setActive: vi.fn(), invalidate: vi.fn() }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    optionLists: {
      list: {
        useQuery: () => ({
          data: [
            { id: 8, category: "Trading rule", value: "No revenge trades", active: true, isDefault: false },
            { id: 9, category: "Setup quality", value: "A+", active: true, isDefault: true },
          ],
        }),
      },
      add: { useMutation: () => ({ mutateAsync: mocks.add, isPending: false }) },
      rename: { useMutation: () => ({ mutateAsync: mocks.rename, isPending: false }) },
      setActive: { useMutation: () => ({ mutateAsync: mocks.setActive, isPending: false }) },
    },
    useUtils: () => ({ optionLists: { list: { invalidate: mocks.invalidate } } }),
  },
}));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: any) => <>{children}</>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));

import { OptionsView } from "./GoldJournal";

describe("OptionsView", () => {
  beforeEach(() => {
    mocks.add.mockReset();
    mocks.rename.mockReset();
    mocks.setActive.mockReset();
    mocks.invalidate.mockReset();
    mocks.add.mockResolvedValue({ success: true });
    mocks.rename.mockResolvedValue({ success: true });
    mocks.setActive.mockResolvedValue({ success: true });
    mocks.invalidate.mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  it("renders the private profile and the canonical Trade Log option manager", () => {
    render(<OptionsView user={{ name: "Naeem", email: "naeem@example.com" }} account={{ id: 1, name: "Primary" }} accounts={[{ id: 1, name: "Primary" }]} onAccount={vi.fn()} onCreate={vi.fn()} onClear={vi.fn()} />);

    expect(screen.getByText("Naeem")).toBeTruthy();
    expect(screen.getByText("Trade Log options")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Setup quality/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Trading rules/ }));
    expect(screen.getByText("No revenge trades")).toBeTruthy();
  });

  it("adds, disables, and renames options from the Options page without a second option system", async () => {
    const clear = vi.fn();
    render(<OptionsView user={{ name: "Naeem", email: "naeem@example.com" }} account={{ id: 1, name: "Primary" }} accounts={[{ id: 1, name: "Primary" }]} onAccount={vi.fn()} onCreate={vi.fn()} onClear={clear} />);

    fireEvent.click(screen.getByRole("button", { name: /^Trading rules/ }));
    fireEvent.change(screen.getByLabelText("Add custom Trading rule option"), { target: { value: "Wait for London close" } });
    fireEvent.click(screen.getByRole("button", { name: /Add option/i }));
    await waitFor(() => expect(mocks.add).toHaveBeenCalledWith({ category: "Trading rule", value: "Wait for London close" }));

    fireEvent.click(screen.getByRole("button", { name: "Disable No revenge trades" }));
    await waitFor(() => expect(mocks.setActive).toHaveBeenCalledWith({ optionId: 8, active: false }));

    fireEvent.click(screen.getByRole("button", { name: "Edit No revenge trades" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "No revenge trades before London close" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(mocks.rename).toHaveBeenCalledWith({ optionId: 8, value: "No revenge trades before London close" }));

    fireEvent.click(screen.getByRole("button", { name: /Clear all trades/i }));
    expect(clear).not.toHaveBeenCalled();
    // The edit dialog is stubbed inline above the confirm dialog, so the last
    // "Cancel" belongs to the clear-trades confirmation.
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" }).at(-1)!);
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Clear all trades/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm clear/i }));
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
