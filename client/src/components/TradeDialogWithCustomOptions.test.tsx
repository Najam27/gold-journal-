// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ add: vi.fn(), invalidate: vi.fn(), mt5SourceData: { current: null as any }, mt5SourceLoading: { current: false } }));
vi.mock("@/lib/trpc", () => ({ trpc: { optionLists: { list: { useQuery: () => ({ data: [{ id: 1, category: "Level", value: "Saved level", active: true }] }) }, add: { useMutation: () => ({ mutateAsync: mocks.add, isPending: false }) } }, trades: { mt5Source: { useQuery: () => ({ data: mocks.mt5SourceData.current, isLoading: mocks.mt5SourceLoading.current }) } }, useUtils: () => ({ optionLists: { list: { invalidate: mocks.invalidate } } }) } }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/textarea", () => ({ Textarea: (props: any) => <textarea {...props} /> }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: ({ children }: any) => <>{children}</>, DialogContent: ({ children }: any) => <div>{children}</div>, DialogDescription: ({ children }: any) => <p>{children}</p>, DialogHeader: ({ children }: any) => <header>{children}</header>, DialogTitle: ({ children }: any) => <h2>{children}</h2> }));

import { TradeDialogWithCustomOptions } from "./TradeDialogWithCustomOptions";
import { TESTING_MODE } from "@/lib/tradeModeConfig";

describe("TradeDialogWithCustomOptions", () => {
  beforeEach(() => { mocks.add.mockReset(); mocks.invalidate.mockReset(); mocks.add.mockResolvedValue({ success: true }); });
  afterEach(() => cleanup());

  it("saves reusable multi-select strategy, execution, and behavior values for the open trade", async () => {
    const form = { tradeDate: "2026-08-12", session: "London", direction: "BUY", result: "WIN", level: "", timeframe: "15m", setupQuality: "A", executionType: "Manual Direct", marketCondition: "", confirmationType: "", patienceScore: "3", risk: "", reward: "", pnl: "", notes: "", emotionBefore: "", emotionDuring: "", emotionAfter: "" };
    const setForm = vi.fn();
    const props = { open: true, setOpen: vi.fn(), setForm, editing: undefined, onSave: vi.fn(), pending: false, screenshot: undefined, setScreenshot: vi.fn(), progress: 0 };
    const { rerender } = render(<TradeDialogWithCustomOptions {...props} form={form} />);
    expect(screen.getByText("Bias")).toBeTruthy();
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

  it("selects the first two level chips by explicit click", () => {
    const form = { tradeDate: "2026-08-12", session: "London", direction: "BUY", result: "WIN", level: "", timeframe: "", setupQuality: "", executionType: "", marketCondition: "", confirmationType: "", mistake: "", patienceScore: "", risk: "", reward: "", pnl: "", notes: "", emotionBefore: "", emotionDuring: "", emotionAfter: "" };
    const setForm = vi.fn();
    render(<TradeDialogWithCustomOptions open setOpen={vi.fn()} form={form} setForm={setForm} editing={{ id: 1 }} onSave={vi.fn()} pending={false} screenshot={undefined} setScreenshot={vi.fn()} progress={0} />);
    fireEvent.click(screen.getByRole("button", { name: "SBR/TJL1" }));
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ level: "SBR/TJL1" }));
    fireEvent.click(screen.getByRole("button", { name: "RBS/TJL1" }));
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ level: "RBS/TJL1" }));
  });

  it("keeps slash-containing level labels selected after the form receives their saved value", () => {
    const form = { tradeDate: "2026-08-12", session: "London", direction: "BUY", result: "WIN", level: "SBR/TJL1", timeframe: "", setupQuality: "", executionType: "", marketCondition: "", confirmationType: "", mistake: "", patienceScore: "", risk: "", reward: "", pnl: "", notes: "", emotionBefore: "", emotionDuring: "", emotionAfter: "" };
    const setForm = vi.fn();
    render(<TradeDialogWithCustomOptions open setOpen={vi.fn()} form={form} setForm={setForm} editing={{ id: 1 }} onSave={vi.fn()} pending={false} screenshot={undefined} setScreenshot={vi.fn()} progress={0} />);
    const selected = screen.getByRole("button", { name: "SBR/TJL1" });
    expect(selected.className).toContain("selected");
    fireEvent.click(selected);
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ level: "" }));
  });

  it("does not select a chip on hover; only an explicit click changes the form", () => {
    const form = { tradeDate: "2026-08-12", session: "London", direction: "BUY", result: "WIN", level: "", timeframe: "", setupQuality: "", executionType: "", marketCondition: "", confirmationType: "", mistake: "", patienceScore: "", risk: "", reward: "", pnl: "", notes: "", emotionBefore: "", emotionDuring: "", emotionAfter: "" };
    const setForm = vi.fn();
    render(<TradeDialogWithCustomOptions open setOpen={vi.fn()} form={form} setForm={setForm} editing={undefined} onSave={vi.fn()} pending={false} screenshot={undefined} setScreenshot={vi.fn()} progress={0} />);
    const fomo = screen.getByRole("button", { name: "FOMO" });
    fireEvent.mouseOver(fomo);
    fireEvent.focus(fomo);
    expect(setForm).not.toHaveBeenCalled();
    fireEvent.click(fomo);
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ mistake: "FOMO" }));
  });

  it("keeps fresh manual Direction and Result on explicit disabled prompts", () => {
    const form = { tradeDate: "2026-08-12", session: "London", direction: "", result: "", level: "", timeframe: "", setupQuality: "", executionType: "", marketCondition: "", confirmationType: "", patienceScore: "", risk: "", reward: "", pnl: "", notes: "", emotionBefore: "", emotionDuring: "", emotionAfter: "" };
    const setForm = vi.fn();
    render(<TradeDialogWithCustomOptions open setOpen={vi.fn()} form={form} setForm={setForm} editing={undefined} onSave={vi.fn()} pending={false} screenshot={undefined} setScreenshot={vi.fn()} progress={0} />);
    const direction = within(screen.getByRole("group", { name: "Direction" })).getByRole("combobox") as HTMLSelectElement;
    const result = within(screen.getByRole("group", { name: "Result" })).getByRole("combobox") as HTMLSelectElement;
    expect(direction.value).toBe("");
    expect(result.value).toBe("");
    expect(screen.getByRole("option", { name: "Select direction" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("option", { name: "Select result" })).toHaveProperty("disabled", true);
    fireEvent.change(direction, { target: { value: "SELL" } });
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ direction: "SELL" }));
  });

  it("shows the Emotions section in Live but hides it in Testing Mode", () => {
    const form = { tradeDate: "2026-10-05", session: "London", direction: "BUY", result: "WIN", level: "", timeframe: "", setupQuality: "", executionType: "", marketCondition: "", biasAlignment: "", bias: { D1: "", H4: "", H1: "", M15: "", M5: "" }, confirmationType: "", slPlacement: "", tpPlacement: "", mistake: "", holdQuality: "", patienceScore: "", planFollowScore: "", risk: "50", reward: "100", pnl: "35", entryPrice: "2650", exitPrice: "", slPrice: "", tpPrice: "", notes: "", emotionBefore: "", emotionDuring: "", emotionAfter: "" };
    const props = { open: true, setOpen: vi.fn(), setForm: vi.fn(), editing: undefined, onSave: vi.fn(), pending: false, screenshot: undefined, setScreenshot: vi.fn(), progress: 0 };
    // Live (default): Emotions visible, editable $ P&L.
    const { unmount } = render(<TradeDialogWithCustomOptions {...props} form={form} />);
    expect(screen.getByText("Emotions")).toBeTruthy();
    expect(screen.getByText("Before trade")).toBeTruthy();
    unmount();
    // Testing: no Emotions, pips are derived and read-only.
    render(<TradeDialogWithCustomOptions {...props} form={form} mode={TESTING_MODE} />);
    expect(screen.queryByText("Emotions")).toBeNull();
    expect(screen.queryByText("Before trade")).toBeNull();
    expect(screen.getByText("Actual pips (auto)")).toBeTruthy();
    expect(screen.getByText("Exit price")).toBeTruthy();
    expect(screen.queryByText("Actual P&L $")).toBeNull();
  });

  it("renders editable MT5 risk fields with Auto-detected badges; typing flips to Manual", () => {
    mocks.mt5SourceData.current = null;
    mocks.mt5SourceLoading.current = false;
    const form = { tradeDate: "2026-08-12", session: "London", direction: "BUY", result: "WIN", mt5Ticket: "987654321", entryPrice: "", slPrice: "", tpPrice: "", risk: "46.4", reward: "", mae: "", mfe: "", pnl: "-48.6", mistake: "", level: "", timeframe: "" };
    const setForm = vi.fn();
    render(<TradeDialogWithCustomOptions open setOpen={vi.fn()} form={form} setForm={setForm} editing={{ id: 9 }} accountId={12} onSave={vi.fn()} pending={false} screenshot={undefined} setScreenshot={vi.fn()} progress={0} />);
    // Risk fields are editable inputs, not read-only text.
    const riskInput = screen.getAllByLabelText("Planned risk $").find(el => el.tagName === "INPUT") as HTMLInputElement;
    expect(riskInput).toBeTruthy();
    expect(riskInput.value).toBe("46.4");
    const entryInput = screen.getAllByLabelText("Entry price").find(el => el.tagName === "INPUT") as HTMLInputElement;
    expect(entryInput).toBeTruthy();
    expect(entryInput.tagName).toBe("INPUT");
    // The untouched auto value carries the Auto-detected badge…
    expect(screen.getAllByText("Auto-detected").length).toBeGreaterThan(0);
    // …which flips to Manual the moment the trader types (and wins on save).
    fireEvent.change(riskInput, { target: { value: "50" } });
    expect(setForm).toHaveBeenCalledWith(expect.objectContaining({ risk: "50" }));
    expect(screen.getAllByText("Manual").length).toBeGreaterThan(0);
  });

  it("backfills empty MT5 risk fields from the linked position on open", () => {
    mocks.mt5SourceData.current = { entryPrice: 2650.5, slPrice: null, tpPrice: null, risk: 46.4, reward: null, mfe: 250, mae: 180 };
    mocks.mt5SourceLoading.current = false;
    const form = { tradeDate: "2026-08-12", session: "London", direction: "BUY", result: "WIN", mt5Ticket: "987654321", entryPrice: "", slPrice: "", tpPrice: "", risk: "", reward: "", mae: "", mfe: "", pnl: "-48.6", mistake: "", level: "", timeframe: "" };
    const setForm = vi.fn();
    render(<TradeDialogWithCustomOptions open setOpen={vi.fn()} form={form} setForm={setForm} editing={{ id: 9 }} accountId={12} onSave={vi.fn()} pending={false} screenshot={undefined} setScreenshot={vi.fn()} progress={0} />);
    // The backfill runs as a functional setForm: only empty fields move.
    const updater = setForm.mock.calls.map(call => call[0]).find(arg => typeof arg === "function");
    expect(updater).toBeTruthy();
    const next = updater(form);
    expect(next.entryPrice).toBe("2650.5");
    expect(next.risk).toBe("46.4");
    expect(next.mfe).toBe("250");
    expect(next.mae).toBe("180");
    // Nulls in the source never overwrite: fields stay empty, never "null".
    expect(next.slPrice).toBe("");
    expect(next.reward).toBe("");
    // A field the form already has keeps its value.
    const withRisk = updater({ ...form, risk: "99" });
    expect(withRisk.risk).toBe("99");
  });
});
