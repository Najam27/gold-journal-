// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ save: vi.fn(), remove: vi.fn() }));

vi.mock("@/lib/trpc", () => ({ trpc: { plans: { save: { useMutation: () => ({ mutateAsync: mocks.save, isPending: false }) }, remove: { useMutation: () => ({ mutateAsync: mocks.remove, isPending: false }) } }, optionLists: { list: { useQuery: () => ({ data: [{ id: 19, category: "Trading rule", value: "Wait for London confirmation", active: true }] }) } } } }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/textarea", () => ({ Textarea: (props: any) => <textarea {...props} /> }));

import { PlanExecutionEditor, planDateTimestamp } from "@/components/PlanExecutionEditor";

describe("PlanExecutionEditor", () => {
  beforeEach(() => { mocks.save.mockReset(); mocks.remove.mockReset(); mocks.save.mockResolvedValue({ success: true }); mocks.remove.mockResolvedValue({ success: true }); });
  afterEach(() => cleanup());

  it("serializes one daily protocol at a canonical PKT instant", () => {
    expect(planDateTimestamp("2026-08-04")).toBe(Date.parse("2026-08-04T12:00:00+05:00"));
  });

  it("loads a saved daily entry and writes its complete execution review on update", async () => {
    const today = new Date();
    const saved = { id: 7, planDate: today, preBias: "Bullish", marketContext: "Asia range compressed", keyLevels: "London high", sessionFocus: ["London"], eventRisk: "CPI at 13:30", longScenario: "Accept above London high", shortScenario: "Reject London high", noTradeCondition: "No clear displacement", invalidationLevel: "Close below Asia low", riskLimit: "150", maxTrades: 3, sizingPlan: "0.5R per A setup", planNotes: "Wait for sweep", rulesPlanned: [{ id: "0", text: "Market event risk checked before entry", checked: true }], emotionStart: "Calm|Focused", emotionEnd: "Disciplined", executionScore: 4, rulesFollowed: [{ id: "0", yes: true }], whatWentWell: "Patience", whatWentWrong: "Late entry", executionNotes: "Waited for confirmation", planDeviation: "None", lessons: "Wait for close", tomorrowFocus: "Trade London only", overallRating: 4 };
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(<PlanExecutionEditor account={{ id: 3 }} plans={[saved]} tradingRules={[{ id: 19, category: "Trading rule", value: "Wait for London confirmation", active: true }]} onSaved={onSaved} />);
    expect(screen.getByText("SAVED SESSION RECORD")).toBeTruthy();
    expect(screen.getByDisplayValue("London high")).toBeTruthy();
    expect(screen.getByDisplayValue("Asia range compressed")).toBeTruthy();
    expect(screen.getByDisplayValue("0.5R per A setup")).toBeTruthy();
    expect(screen.getByDisplayValue("Patience")).toBeTruthy();
    expect(screen.getByLabelText("Search saved protocols")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update protocol" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ accountId: 3, preBias: "Bullish", marketContext: "Asia range compressed", keyLevels: "London high", riskLimit: "150", maxTrades: 3, executionScore: 4, overallRating: 4, whatWentWell: "Patience", lessons: "Wait for close", tomorrowFocus: "Trade London only" })));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("keeps the entry visible and reports a save failure for retry", async () => {
    mocks.save.mockRejectedValueOnce(new Error("Cloud connection interrupted"));
    render(<PlanExecutionEditor account={{ id: 3 }} plans={[]} tradingRules={[{ id: 19, category: "Trading rule", value: "Wait for London confirmation", active: true }]} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("The one execution priority that matters today."), { target: { value: "Wait for confirmation" } });
    fireEvent.click(screen.getByRole("button", { name: "Save protocol" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Cloud connection interrupted"));
    expect(screen.getByDisplayValue("Wait for confirmation")).toBeTruthy();
  });

  it("shows an account-scoped saved protocol after the archive search debounce", async () => {
    vi.useFakeTimers();
    const today = new Date();
    render(<PlanExecutionEditor account={{ id: 3 }} plans={[{ id: 7, planDate: today, preBias: "Bullish", keyLevels: "London high", rulesPlanned: [], rulesFollowed: [] }]} tradingRules={[{ id: 19, category: "Trading rule", value: "Wait for London confirmation", active: true }]} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search saved protocols"), { target: { value: "London" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(screen.getByText(/Bullish · London high/)).toBeTruthy();
    vi.useRealTimers();
  });
});
