// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildAnalysis } from "@shared/analysisEngine";
import { AnalysisDashboard } from "./AnalysisDashboard";

const analysis = buildAnalysis([{ tradeDate: "2026-01-01", result: "WIN", pnl: 10, risk: 10, reward: 20, session: "London", timeframe: "M5", level: "Support", setupQuality: "A", direction: "BUY" }]);

vi.mock("@/lib/trpc", () => ({ trpc: { analysis: { config: { useQuery: () => ({ data: { configured: false, vaultAvailable: true, model: null }, isLoading: false, error: null }) }, get: { useQuery: () => ({ data: analysis, isLoading: false, isError: false }) }, compare: { useQuery: () => ({ data: undefined }) }, ai: { useMutation: () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn(), data: undefined, error: null }) } }, aiJobs: { status: { useQuery: () => ({ data: undefined }) } } } }));

describe("AnalysisDashboard", () => {
  it("renders deterministic evidence before optional AI output", () => {
    render(<AnalysisDashboard accountId={1} />);
    expect(screen.getByText("Analysis & Edge Development")).toBeTruthy();
    expect(screen.getByText("SESSION ANALYSIS")).toBeTruthy();
    expect(screen.getByText("AVERAGE PLANNED R:R")).toBeTruthy();
    expect(screen.getByText("AVERAGE ACTUAL R")).toBeTruthy();
    expect(screen.getByText("AVERAGE TARGET CAPTURE")).toBeTruthy();
    expect(screen.getAllByText("INSUFFICIENT DATA").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/MFE\/MAE/).length).toBeGreaterThan(0);
    expect(screen.getByText(/no excursion series is stored/i)).toBeTruthy();
  });
});
