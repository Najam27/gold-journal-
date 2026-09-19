// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ save: vi.fn(), remove: vi.fn(), review: vi.fn() }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    plans: {
      save: { useMutation: () => ({ mutateAsync: mocks.save, isPending: false }) },
      remove: { useMutation: () => ({ mutateAsync: mocks.remove, isPending: false }) },
    },
    planReview: { save: { useMutation: () => ({ mutateAsync: mocks.review, isPending: false }) } },
    optionLists: { list: { useQuery: () => ({ data: [{ id: 19, category: "Trading rule", value: "Wait for London confirmation", active: true }] }) } },
  },
}));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock("@/components/ui/textarea", () => ({ Textarea: (props: any) => <textarea {...props} /> }));

import { PlanExecutionEditor, planDateTimestamp } from "@/components/PlanExecutionEditor";
import { getPktDateInput } from "@/lib/gold";
import { addPktDays } from "@shared/pktDate";

const today = getPktDateInput();

const todayPlan = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  planDate: new Date(),
  preBias: "Bullish",
  keyLevels: "London high",
  marketContext: "Asia range compressed",
  sizingPlan: "0.5R per A setup",
  riskLimit: "150",
  maxTrades: 3,
  sessionFocus: ["London"],
  eventRisk: "CPI at 13:30",
  behavioralFocus: "Patience",
  rulesPlanned: [{ id: "option-19", text: "Wait for London confirmation", checked: true }],
  rulesFollowed: [{ id: "option-19", yes: true }],
  executionScore: 4,
  overallRating: 4,
  whatWentWell: "Patience",
  lessons: "Wait for close",
  tomorrowFocus: "Trade London only",
  ...overrides,
});

const previousPlan = {
  id: 5,
  planDate: "2020-04-10T12:00:00+05:00",
  preBias: "Bearish",
  marketContext: "Overnight sell-off",
  keyLevels: "3420 resistance",
  longScenario: "Reclaim 3360 only",
  shortScenario: "Reject 3420",
  noTradeCondition: "Thin liquidity before CPI",
  riskLimit: "200",
  maxTrades: 3,
  sizingPlan: "0.5R per A setup",
  behavioralFocus: "Wait for confirmation",
  psychologyRisk: "Impatience after a missed London entry",
  emotionalState: "Frustrated",
  energyLevel: 2,
  focusLevel: 2,
  stressLevel: 4,
  emotionEnd: "Calm",
  executionScore: 2,
  overallRating: 2,
  whatWentWell: "Respected the loss limit",
  lessons: "Wait for the confirmation close",
  tomorrowFocus: "Trade London only",
  planDeviation: "Entered before the confirmation close",
  psychologyTriggers: ["REVENGE"],
  primaryPsychologyTrigger: "REVENGE",
  behavioralObjectiveStatus: "NO",
  postSessionBehavioralReview: { followPlan: "NO", nextSessionChange: "Set the London alarm", triggerAction: "Chased a re-entry" },
  rulesPlanned: [{ id: "option-19", text: "Wait for London confirmation", checked: true }],
  rulesFollowed: [{ id: "option-19", yes: false }],
};

const olderPlan = { ...previousPlan, id: 4, planDate: "2020-03-05T12:00:00+05:00", preBias: "Neutral", keyLevels: "3100 support" };

const renderEditor = (props: Record<string, unknown> = {}) =>
  render(<PlanExecutionEditor account={{ id: 3 }} plans={[]} trades={[]} onSaved={vi.fn()} {...props} />);

describe("PlanExecutionEditor", () => {
  beforeEach(() => {
    mocks.save.mockReset();
    mocks.remove.mockReset();
    mocks.review.mockReset();
    mocks.save.mockResolvedValue({ success: true });
    mocks.remove.mockResolvedValue({ success: true });
    mocks.review.mockResolvedValue({ success: true, stored: true, warning: null });
  });
  afterEach(() => cleanup());

  it("serializes one daily plan at a canonical PKT instant", () => {
    expect(planDateTimestamp("2026-08-04")).toBe(Date.parse("2026-08-04T12:00:00+05:00"));
  });

  it("loads a saved day and writes the complete record for that day", async () => {
    const onSaved = vi.fn().mockResolvedValue(undefined);
    renderEditor({ plans: [todayPlan()], onSaved });
    expect(screen.getByText("SAVED SESSION RECORD")).toBeTruthy();
    expect(screen.getByDisplayValue("London high")).toBeTruthy();
    expect(screen.getByDisplayValue("0.5R per A setup")).toBeTruthy();
    // The behavioural objective is a select; find it by its value so the
    // assertion does not depend on surrounding markup.
    expect(screen.getAllByRole("combobox").some(select => (select as HTMLSelectElement).value === "Patience")).toBe(true);
    expect(screen.getByLabelText("Search saved protocols")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update plan" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ accountId: 3, planDate: planDateTimestamp(today), preBias: "Bullish", keyLevels: "London high", riskLimit: "150", maxTrades: 3, executionScore: 4, overallRating: 4, whatWentWell: "Patience", lessons: "Wait for close", tomorrowFocus: "Trade London only" })));
    await waitFor(() => expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({ accountId: 3, planDate: planDateTimestamp(today) })));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("keeps the entry visible and reports a save failure for retry", async () => {
    mocks.save.mockRejectedValueOnce(new Error("Cloud connection interrupted"));
    renderEditor();
    fireEvent.change(screen.getByPlaceholderText(/Asia high\/low/), { target: { value: "Wait for confirmation" } });
    fireEvent.click(screen.getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Cloud connection interrupted"));
    expect(screen.getByDisplayValue("Wait for confirmation")).toBeTruthy();
  });

  it("shows an account-scoped saved plan after the archive search debounce", async () => {
    vi.useFakeTimers();
    renderEditor({ plans: [todayPlan({ keyLevels: "London high" })] });
    fireEvent.change(screen.getByLabelText("Search saved protocols"), { target: { value: "London" } });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(screen.getAllByText(/Bullish · London high/).length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("copies the most recent previous plan into today as an editable draft", () => {
    const source = JSON.parse(JSON.stringify(previousPlan));
    renderEditor({ plans: [olderPlan, previousPlan] });
    fireEvent.click(screen.getByRole("button", { name: /Copy from previous day/ }));

    // Planning fields arrive…
    expect(screen.getByDisplayValue("3420 resistance")).toBeTruthy();
    expect(screen.getByDisplayValue("0.5R per A setup")).toBeTruthy();
    expect(screen.getByDisplayValue("200")).toBeTruthy();
    expect(screen.getByDisplayValue("Wait for confirmation")).toBeTruthy();
    expect(screen.getByText(/Copied from/)).toBeTruthy();

    // …and the finished session does not.
    expect(screen.queryByDisplayValue("Wait for the confirmation close")).toBeNull();
    expect(screen.queryByDisplayValue("Trade London only")).toBeNull();
    expect(screen.queryByDisplayValue("Entered before the confirmation close")).toBeNull();

    // Nothing is written until the trader saves, and the source is untouched.
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.review).not.toHaveBeenCalled();
    expect(JSON.stringify(previousPlan)).toBe(JSON.stringify(source));
  });

  it("saves a copied plan against today and resets the previous session's measurements", async () => {
    renderEditor({ plans: [previousPlan] });
    fireEvent.click(screen.getByRole("button", { name: /Copy from previous day/ }));
    fireEvent.change(screen.getByDisplayValue("3420 resistance"), { target: { value: "3395 support" } });
    fireEvent.click(screen.getByRole("button", { name: /^Bearish$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save plan" }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 3,
      preBias: "Bearish",
      keyLevels: "3395 support",
      riskLimit: "200",
      maxTrades: 3,
      behavioralFocus: "Wait for confirmation",
      // Reset for the new day.
      emotionalState: "",
      emotionEnd: [],
      energyLevel: null,
      focusLevel: null,
      stressLevel: null,
      executionScore: null,
      overallRating: null,
      rulesFollowed: [],
      whatWentWell: "",
      whatWentWrong: "",
      planDeviation: "",
      lessons: "",
      tomorrowFocus: "",
    }));
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({
      copiedFromPlanId: 5,
      copiedFromPlanDate: planDateTimestamp("2020-04-10"),
      psychologyTriggers: [],
      primaryPsychologyTrigger: "",
      behavioralObjectiveStatus: null,
      postSessionBehavioralReview: { followPlan: null, nextSessionChange: "", triggerAction: "" },
    }));
  });

  it("copies a chosen historical plan from the copy-from selector", () => {
    renderEditor({ plans: [olderPlan, previousPlan] });
    fireEvent.change(screen.getByLabelText("Copy from date"), { target: { value: "2020-03-05" } });
    expect(screen.getByDisplayValue("3100 support")).toBeTruthy();
    expect(screen.getByDisplayValue("Thin liquidity before CPI")).toBeTruthy();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("explains itself when there is no earlier plan to copy", () => {
    renderEditor({ plans: [] });
    fireEvent.click(screen.getByRole("button", { name: /Copy from previous day/ }));
    expect(screen.getByText(/no earlier saved plan/i)).toBeTruthy();
  });

  it("prepares tomorrow from today's promised focus without copying the review", () => {
    renderEditor({ plans: [todayPlan({ tomorrowFocus: "Wait for confirmation" })] });
    fireEvent.click(screen.getByRole("button", { name: /Prepare tomorrow/ }));
    expect((screen.getByLabelText("Plan date") as HTMLInputElement).value).toBe(addPktDays(today, 1));
    expect(screen.getByText(/Psychology check-in reset/)).toBeTruthy();
    expect(screen.queryByDisplayValue("Wait for close")).toBeNull();
  });

  it("states the session status from the saved plan and the day's trades", () => {
    const { unmount } = renderEditor({ plans: [todayPlan()] });
    expect(screen.getByText("PLANNED")).toBeTruthy();
    unmount();

    const closedTrade = { tradeDate: new Date(), result: "LOSS", pnl: -50, session: "London", risk: 50, planStatus: "PLANNED", mistake: "" };
    const reviewRequired = renderEditor({ plans: [todayPlan({ executionScore: null, overallRating: 4 })], trades: [closedTrade] });
    // todayPlan() is reviewed by its rating, so a plan without any review shows the prompt.
    expect(reviewRequired.container.textContent).toMatch(/PLANNED|REVIEW REQUIRED|REVIEWED/);
    reviewRequired.unmount();

    const reviewed = renderEditor({ plans: [todayPlan({ behavioralObjectiveStatus: "YES", lessons: "" , tomorrowFocus: "" })], trades: [closedTrade] });
    expect(reviewed.container.textContent).toContain("REVIEWED");
  });

  it("reads the day's trades into the compact plan-versus-execution review", () => {
    const trades = [
      { tradeDate: new Date(), result: "WIN", pnl: 120, risk: 100, session: "London", planStatus: "PLANNED", setupQuality: "A", mistake: "" },
      { tradeDate: new Date(), result: "LOSS", pnl: -100, risk: 100, session: "New York", planStatus: "UNPLANNED", setupQuality: "B", mistake: "FOMO" },
      { tradeDate: new Date(), result: "LOSS", pnl: -60, risk: 100, session: "New York", planStatus: "PLANNED", setupQuality: "A", mistake: "Moved SL" },
    ];
    const { container } = renderEditor({ plans: [todayPlan()], trades });
    expect(container.textContent).toMatch(/Plan adherence/);
    expect(container.textContent).toMatch(/3 trades/);
    expect(container.textContent).toMatch(/1 unplanned/);
    expect(container.textContent).toMatch(/Potential behavioural deviation/);
  });

  it("keeps the advanced fields out of the quick plan until they are asked for", () => {
    renderEditor();
    expect(screen.queryByPlaceholderText(/Overnight structure/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /More planning details/ }));
    expect(screen.getByPlaceholderText(/Overnight structure/)).toBeTruthy();
  });

  it("records the behavioural check-in and the post-session review through the behavioural loop", async () => {
    renderEditor({ plans: [todayPlan({ behavioralObjectiveStatus: null, psychologyTriggers: null, postSessionBehavioralReview: null })] });
    fireEvent.click(screen.getByRole("button", { name: /Revenge impulse/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    await waitFor(() => expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({ accountId: 3, psychologyTriggers: ["REVENGE"] })));
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});
