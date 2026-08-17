// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnalysisEdge } from "./AnalysisEdge";

describe("AnalysisEdge", () => {
  it("renders session, timeframe, level, and combined-context edge tables", () => {
    render(<AnalysisEdge trades={[
      { session: "London", timeframe: "15m", level: "QML", result: "WIN", pnl: 80 },
      { session: "London", timeframe: "15m", level: "QML", result: "LOSS", pnl: -20 },
    ]} />);

    expect(screen.getByText("SESSION EDGE")).toBeTruthy();
    expect(screen.getByText("TIMEFRAME EDGE")).toBeTruthy();
    expect(screen.getByText("LEVEL EDGE")).toBeTruthy();
    expect(screen.getByText("SESSION × TIMEFRAME")).toBeTruthy();
    expect(screen.getByText("London · 15m")).toBeTruthy();
    expect(screen.getByText("Trade discipline autopilot")).toBeTruthy();
    expect(screen.getByText("LOSS GUARDRAIL")).toBeTruthy();
    expect(screen.getByText("JOURNAL QUALITY")).toBeTruthy();
  });
});
