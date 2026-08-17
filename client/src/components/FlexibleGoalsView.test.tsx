// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlexibleGoalsView } from "./FlexibleGoalsView";

const handlers = { onCreate: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onClear: vi.fn() };
const baseProps = { account: { id: 1 }, trades: [], plans: [], pending: false, ...handlers };

describe("FlexibleGoalsView", () => {
  beforeEach(() => { Object.values(handlers).forEach(handler => handler.mockReset()); vi.spyOn(window, "confirm").mockReturnValue(true); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("starts with a blank strategy-control desk rather than generic seeded targets", () => {
    render(<FlexibleGoalsView {...baseProps} goals={[]} />);
    expect(screen.getByText("No generic goals. Build a control desk.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add first control" }));
    expect(screen.getByText("Choose a rule to configure")).toBeTruthy();
    expect(screen.getByText("Max daily loss")).toBeTruthy();
    expect(screen.getByText("Behavior breach ceiling")).toBeTruthy();
    expect(screen.getByText("Risk-defined trade rate")).toBeTruthy();
    expect(screen.getByText("Minimum closed-trade sample")).toBeTruthy();
    expect(screen.getByText("Strategy compliance")).toBeTruthy();
  });

  it("activates a concrete behavior control with a direct threshold and alert preference", async () => {
    render(<FlexibleGoalsView {...baseProps} goals={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add control" }));
    fireEvent.click(screen.getByRole("button", { name: /Behavior breach ceiling/i }));
    fireEvent.change(screen.getByLabelText("Allowed tagged trades"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Alert when action is required/i }));
    fireEvent.click(screen.getByRole("button", { name: "Activate control" }));
    await waitFor(() => expect(handlers.onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Behavior breach ceiling", period: "DAILY", metric: "behavior_breaches", comparison: "LTE", target: 0, notify: false, active: true })));
    expect(handlers.onCreate.mock.calls[0][0].description).toContain("gold-journal-control-v1");
  });

  it("tracks loss, behavior, plan-review, pause, alert, delete, and clear states from saved journal data", async () => {
    render(<FlexibleGoalsView {...baseProps} goals={[
      { id: 9, name: "Loss ceiling", description: "Stop after the limit.", period: "DAILY", metric: "daily_loss", comparison: "LTE", target: 100, notify: true, active: true },
      { id: 10, name: "Behavior ceiling", description: "Tag every recovery entry.", period: "DAILY", metric: "behavior_breaches", comparison: "LTE", target: 0, notify: false, active: true },
      { id: 11, name: "Weekly review", description: "Review execution.", period: "WEEKLY", metric: "weekly_reviews", comparison: "GTE", target: 1, notify: true, active: true },
    ]} trades={[{ tradeDate: new Date(), result: "LOSS", pnl: -150, mistake: "Revenge" }]} plans={[{ planDate: new Date(), overallRating: 4 }]} />);
    expect(screen.getByText("Loss ceiling")).toBeTruthy();
    expect(screen.getByText("Behavior ceiling")).toBeTruthy();
    expect(screen.getByText("Stop for the day and protect tomorrow’s capital.")).toBeTruthy();
    ["Control", "Scope", "Progress", "Status", "Next action"].forEach(label => expect(screen.getByRole("columnheader", { name: label })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Weekly" })).toBeTruthy();
    expect(document.querySelectorAll(".control-table tr.risk").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByTitle("Pause control")[0]);
    fireEvent.click(screen.getAllByTitle("Disable control alerts")[0]);
    fireEvent.click(screen.getAllByTitle("Delete control")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Clear controls/i }));
    await waitFor(() => {
      expect(handlers.onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 9, active: false }));
      expect(handlers.onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 9, notify: false }));
      expect(handlers.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }));
      expect(handlers.onClear).toHaveBeenCalledTimes(1);
    });
  });
});
