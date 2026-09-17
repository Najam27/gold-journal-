// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRADE_OPTION_CATEGORIES } from "@shared/tradeOptionCategories";

const mocks = vi.hoisted(() => ({
  options: [] as any[],
  add: vi.fn(),
  rename: vi.fn(),
  setActive: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    optionLists: {
      list: { useQuery: () => ({ data: mocks.options }) },
      add: { useMutation: () => ({ mutateAsync: mocks.add, isPending: false }) },
      rename: { useMutation: () => ({ mutateAsync: mocks.rename, isPending: false }) },
      setActive: { useMutation: () => ({ mutateAsync: mocks.setActive, isPending: false }) },
    },
    useUtils: () => ({ optionLists: { list: { invalidate: mocks.invalidate } } }),
  },
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: any) => <>{children}</>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogHeader: ({ children }: any) => <header>{children}</header>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));

import { TradeOptionManager } from "./TradeOptionManager";

const openCategory = (label: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));

describe("TradeOptionManager", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => (mock as any).mockReset?.());
    mocks.options = [
      { id: 1, category: "Setup quality", value: "A+", active: true, isDefault: true },
      { id: 2, category: "Setup quality", value: "Institutional", active: true, isDefault: false },
      { id: 3, category: "Setup quality", value: "Retired grade", active: false, isDefault: true },
      { id: 4, category: "Session", value: "London", active: true, isDefault: true },
    ];
    mocks.add.mockResolvedValue({ success: true });
    mocks.rename.mockResolvedValue({ success: true });
    mocks.setActive.mockResolvedValue({ success: true });
    mocks.invalidate.mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  it("offers every Trade Log category so defaults and custom options are managed in one place", () => {
    render(<TradeOptionManager />);
    for (const entry of TRADE_OPTION_CATEGORIES) {
      expect(screen.getByRole("button", { name: new RegExp(`^${entry.label}`) })).toBeTruthy();
    }
  });

  it("treats a seeded default and a custom option identically: both are listed, renameable, and toggleable", () => {
    render(<TradeOptionManager initialCategory="Setup quality" />);

    expect(screen.getByText("A+")).toBeTruthy();
    expect(screen.getByText("Institutional")).toBeTruthy();
    expect(screen.getByText("Retired grade")).toBeTruthy();
    expect(screen.getAllByText("Default")).toHaveLength(2);
    expect(screen.getAllByText("Custom")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Edit A+" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disable A+" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable Retired grade" })).toBeTruthy();
  });

  it("adds a reusable option to the selected category", async () => {
    render(<TradeOptionManager />);
    openCategory("Setup quality");
    fireEvent.change(screen.getByLabelText("Add custom Setup quality option"), { target: { value: "A++ Institutional" } });
    fireEvent.click(screen.getByRole("button", { name: /Add option/i }));

    await waitFor(() => expect(mocks.add).toHaveBeenCalledWith({ category: "Setup quality", value: "A++ Institutional" }));
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalled());
  });

  it("refuses a duplicate name in the same category before calling the server", () => {
    render(<TradeOptionManager initialCategory="Setup quality" />);
    fireEvent.change(screen.getByLabelText("Add custom Setup quality option"), { target: { value: " a+ " } });
    fireEvent.click(screen.getByRole("button", { name: /Add option/i }));

    expect(mocks.add).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("“A+” already exists in Setup quality.");
  });

  it("renames a Gold Journal default so the dropdown immediately uses the new name", async () => {
    render(<TradeOptionManager initialCategory="Setup quality" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit A+" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "A+ Institutional" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(mocks.rename).toHaveBeenCalledWith({ optionId: 1, value: "A+ Institutional" }));
  });

  it("refuses a rename that collides with another option in the category", () => {
    render(<TradeOptionManager initialCategory="Setup quality" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit A+" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "institutional" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(mocks.rename).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("“Institutional” already exists in Setup quality.");
  });

  it("disables an option without deleting it, and re-enables it again", async () => {
    render(<TradeOptionManager initialCategory="Setup quality" />);
    fireEvent.click(screen.getByRole("button", { name: "Disable A+" }));
    await waitFor(() => expect(mocks.setActive).toHaveBeenCalledWith({ optionId: 1, active: false }));

    fireEvent.click(screen.getByRole("button", { name: "Enable Retired grade" }));
    await waitFor(() => expect(mocks.setActive).toHaveBeenLastCalledWith({ optionId: 3, active: true }));
  });
});
