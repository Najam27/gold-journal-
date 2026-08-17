// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MonthlyTradeOverview } from "./MonthlyTradeOverview";

afterEach(() => cleanup());

describe("MonthlyTradeOverview", () => {
  it("searches recorded months through a themed listbox instead of a browser-native select", () => {
    render(<MonthlyTradeOverview trades={[{ tradeDate: "2026-08-12T12:00:00.000Z", result: "WIN", pnl: "100", risk: "20", reward: "100" }, { tradeDate: "2026-07-12T12:00:00.000Z", result: "LOSS", pnl: "-20", risk: "20", reward: "40" }]} />);
    expect(screen.queryByRole("combobox", { name: /overview month/i })).toBeNull();
    fireEvent.change(screen.getByLabelText("Search overview month"), { target: { value: "July" } });
    const trigger = screen.getAllByRole("button").find(button => /2026/.test(button.textContent ?? ""));
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger!);
    fireEvent.click(screen.getByRole("option", { name: /jul 2026/i }));
    expect(screen.getByText("July 2026 overview")).toBeTruthy();
  });
});
