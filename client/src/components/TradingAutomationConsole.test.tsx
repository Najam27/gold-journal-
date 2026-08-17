/** @vitest-environment jsdom */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TradingAutomationConsole } from "./TradingAutomationConsole";

describe("TradingAutomationConsole", () => {
  beforeEach(() => localStorage.clear());

  it("detects a consecutive-loss guardrail and lets the trader disable only the local prompt", () => {
    render(<TradingAutomationConsole trades={[
      { session: "London", timeframe: "15m", level: "QML", result: "LOSS", pnl: -20, tradeDate: 2 },
      { session: "London", timeframe: "15m", level: "QML", result: "LOSS", pnl: -10, tradeDate: 1 },
    ]} />);

    expect(screen.getByText("Pause after 2 consecutive losses")).toBeTruthy();
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("gj_workflow_automation")).toBe("off");
  });
});
