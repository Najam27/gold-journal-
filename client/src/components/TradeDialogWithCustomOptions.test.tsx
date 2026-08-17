// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ add: vi.fn(), invalidate: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: { optionLists: { list: { useQuery: () => ({ data: [{ id: 1, category: "Level", value: "Saved level", active: true }] }) }, add: { useMutation: () => ({ mutateAsync: mocks.add, isPending: false }) } }, useUtils: () => ({ optionLists: { list: { invalidate: mocks.invalidate } } }) } }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/textarea", () => ({ Textarea: (props: any) => <textarea {...props} /> }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: ({ children }: any) => <>{children}</>, DialogContent: ({ children }: any) => <div>{children}</div>, DialogDescription: ({ children }: any) => <p>{children}</p>, DialogHeader: ({ children }: any) => <header>{children}</header>, DialogTitle: ({ children }: any) => <h2>{children}</h2> }));

import { TradeDialogWithCustomOptions } from "./TradeDialogWithCustomOptions";

describe("TradeDialogWithCustomOptions", () => {
  beforeEach(() => { mocks.add.mockReset(); mocks.invalidate.mockReset(); mocks.add.mockResolvedValue({ success: true }); });
  afterEach(() => cleanup());

  it("saves reusable multi-select strategy, execution, and behavior values for the open trade", async () => {
    const form = { tradeDate: "2026-08-12", session: "London", direction: "BUY", result: "WIN", level: "", timeframe: "15m", setupQuality: "A", executionType: "Manual Direct", marketCondition: "", confirmationType: "", patienceScore: "3", risk: "", reward: "", pnl: "", notes: "", emotionBefore: "", emotionDuring: "", emotionAfter: "" };
    const setForm = vi.fn();
    const props = { open: true, setOpen: vi.fn(), setForm, editing: undefined, onSave: vi.fn(), pending: false, screenshot: undefined, setScreenshot: vi.fn(), progress: 0 };
    const { rerender } = render(<TradeDialogWithCustomOptions {...props} form={form} />);
    expect(screen.getByText("Direction vs bias")).toBeTruthy();
    expect(screen.getByText("SL placement")).toBeTruthy();
    expect(screen.getByText("TP placement")).toBeTruthy();
    expect(screen.getByText("Mistake / rule-break tags")).toBeTruthy();
    expect(screen.getByText("Hold quality")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Saved level" })).toBeTruthy();
    ["FOMO", "Revenge", "Overtrading", "Oversize"].forEach(tag => expect(screen.getByRole("button", { name: tag })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "FOMO" }));
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ mistake: "FOMO" }));
    rerender(<TradeDialogWithCustomOptions {...props} form={{ ...form, mistake: "FOMO" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Revenge" }));
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ mistake: "FOMO | Revenge" }));
    fireEvent.change(screen.getByLabelText("Add custom Mistake option"), { target: { value: "Ignored news" } });
    fireEvent.click(screen.getByLabelText("Save custom Mistake option"));
    await waitFor(() => expect(mocks.add).toHaveBeenCalledWith({ category: "Mistake", value: "Ignored news" }));
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ mistake: "FOMO | Ignored news" }));
    fireEvent.click(screen.getByRole("button", { name: "Saved level" }));
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ level: "Saved level" }));
    rerender(<TradeDialogWithCustomOptions {...props} form={{ ...form, level: "Saved level" }} />);
    fireEvent.change(screen.getByLabelText("Add custom Level option"), { target: { value: "Custom zone" } });
    fireEvent.click(screen.getByLabelText("Save custom Level option"));
    await waitFor(() => expect(mocks.add).toHaveBeenCalledWith({ category: "Level", value: "Custom zone" }));
    await waitFor(() => expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ level: "Saved level | Custom zone" })));
    fireEvent.click(screen.getByText("BOS"));
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ confirmationType: "BOS" }));
    rerender(<TradeDialogWithCustomOptions {...props} form={{ ...form, confirmationType: "BOS" }} />);
    fireEvent.click(screen.getByRole("button", { name: "CHoCH" }));
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ confirmationType: "BOS | CHoCH" }));
    fireEvent.click(screen.getByText("Trending"));
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ marketCondition: "Trending" }));
  });

  it("keeps fresh manual Direction and Result on explicit disabled prompts", () => {
    const form = { tradeDate: "2026-08-12", session: "London", direction: "", result: "", level: "", timeframe: "", setupQuality: "", executionType: "", marketCondition: "", confirmationType: "", patienceScore: "", risk: "", reward: "", pnl: "", notes: "", emotionBefore: "", emotionDuring: "", emotionAfter: "" };
    const setForm = vi.fn();
    render(<TradeDialogWithCustomOptions open setOpen={vi.fn()} form={form} setForm={setForm} editing={undefined} onSave={vi.fn()} pending={false} screenshot={undefined} setScreenshot={vi.fn()} progress={0} />);
    const direction = screen.getByLabelText("Direction", { exact: true }) as HTMLSelectElement;
    const result = screen.getByLabelText("Result", { exact: true }) as HTMLSelectElement;
    expect(direction.value).toBe("");
    expect(result.value).toBe("");
    expect(screen.getByRole("option", { name: "Select direction" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("option", { name: "Select result" })).toHaveProperty("disabled", true);
    fireEvent.change(direction, { target: { value: "SELL" } });
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ direction: "SELL" }));
  });
});
