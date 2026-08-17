// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ add: vi.fn(), setActive: vi.fn(), invalidate: vi.fn() }));

vi.mock("@/lib/trpc", () => ({ trpc: { optionLists: { list: { useQuery: () => ({ data: [{ id: 8, category: "Trading rule", value: "No revenge trades", active: true }] }) }, add: { useMutation: () => ({ mutateAsync: mocks.add, isPending: false }) }, setActive: { useMutation: () => ({ mutateAsync: mocks.setActive, isPending: false }) } }, useUtils: () => ({ optionLists: { list: { invalidate: mocks.invalidate } } }) } }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));

import { OptionsView } from "./GoldJournal";

describe("OptionsView", () => {
  beforeEach(() => { mocks.add.mockReset(); mocks.setActive.mockReset(); mocks.invalidate.mockReset(); });
  afterEach(() => cleanup());

  it("renders the private profile and supports in-page rule add/toggle/reset workflows", async () => {
    const clear = vi.fn();
    render(<OptionsView user={{ name: "Naeem", email: "naeem@example.com" }} account={{ id: 1, name: "Primary" }} accounts={[{ id: 1, name: "Primary" }]} onAccount={vi.fn()} onCreate={vi.fn()} onClear={clear} />);
    expect(screen.getByText("Naeem")).toBeTruthy();
    expect(screen.getByText("No revenge trades")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("New rule or dropdown value"), { target: { value: "Wait for London close" } });
    fireEvent.click(screen.getAllByRole("button", { name: /^Add$/ })[1]);
    await waitFor(() => expect(mocks.add).toHaveBeenCalledWith({ category: "Trading rule", value: "Wait for London close" }));
    fireEvent.click(screen.getByLabelText("No revenge trades"));
    await waitFor(() => expect(mocks.setActive).toHaveBeenCalledWith({ optionId: 8, active: false }));
    fireEvent.click(screen.getByRole("button", { name: /Clear all trades/i }));
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Clear all trades/i }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm clear/i }));
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
