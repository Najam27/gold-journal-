/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateRisk, type RiskCalculation } from "@shared/riskCalculator";

const mocks = vi.hoisted(() => ({
  isLoading: false,
  error: null as { message: string } | null,
  data: undefined as any,
  inputs: [] as any[],
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    mt5: {
      risk: {
        useQuery: (input: any) => {
          mocks.inputs.push(input);
          return { data: mocks.data, isLoading: mocks.isLoading, error: mocks.error };
        },
      },
    },
  },
}));
vi.mock("@/lib/accountSelection", () => ({
  getSelectedAccountId: () => 12,
  subscribeSelectedAccount: () => () => {},
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input {...props} />,
}));

import { RiskCalculatorPanel } from "./RiskCalculatorPanel";

const account = { balance: 10_000, equity: 10_000, margin: 100, freeMargin: 9_900, currency: "USD" };
const spec = { symbol: "XAUUSDm", tickSize: 0.1, tickValueLoss: 10, contractSize: 100, volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01 };
const levels = { entryPrice: 2350, stopLoss: 2344, takeProfit: null };

const calculation = (overrides: Partial<Parameters<typeof calculateRisk>[0]> = {}) =>
  calculateRisk(
    { basis: "EQUITY", riskProfile: "STANDARD", riskPercent: 1, direction: "BUY", ...levels, ...overrides },
    account,
    spec
  ) as RiskCalculation;

const lastInput = () => mocks.inputs[mocks.inputs.length - 1];

function renderWithLevels() {
  render(<RiskCalculatorPanel />);
  fireEvent.change(screen.getByLabelText("Entry price"), { target: { value: "2350" } });
  fireEvent.change(screen.getByLabelText("Stop loss"), { target: { value: "2344" } });
}

beforeEach(() => {
  mocks.isLoading = false;
  mocks.error = null;
  mocks.data = calculation();
  mocks.inputs = [];
});

afterEach(cleanup);

describe("RiskCalculatorPanel · risk profiles", () => {
  it("renders every predefined profile with its percentage", () => {
    render(<RiskCalculatorPanel />);
    for (const [label, percent] of [
      ["Conservative", "0.50%"],
      ["Low", "0.75%"],
      ["Standard", "1.00%"],
      ["Moderate", "1.50%"],
      ["High", "2.00%"],
      ["Custom", "0.01–10%"],
    ]) {
      expect(screen.getByRole("radio", { name: new RegExp(label) })).toBeTruthy();
      expect(screen.getByText(percent)).toBeTruthy();
    }
  });

  it("defaults to Standard at 1.00% without asking AI", () => {
    render(<RiskCalculatorPanel />);
    expect(screen.getByRole("radio", { name: /Standard/ }).getAttribute("aria-checked")).toBe("true");
    expect(lastInput().riskProfile).toBe("STANDARD");
    expect(lastInput().riskPercent).toBe(1);
  });

  it("switches the risk percentage when another profile is selected", () => {
    render(<RiskCalculatorPanel />);
    fireEvent.click(screen.getByRole("radio", { name: /Conservative/ }));
    expect(lastInput().riskProfile).toBe("CONSERVATIVE");
    expect(lastInput().riskPercent).toBe(0.5);
    expect(screen.getByRole("radio", { name: /Conservative/ }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: /Standard/ }));
    expect(lastInput().riskPercent).toBe(1);
  });

  it("reveals a bounded custom risk input only when Custom is selected", () => {
    render(<RiskCalculatorPanel />);
    expect(screen.queryByLabelText("Custom risk %")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /Custom/ }));
    const input = screen.getByLabelText("Custom risk %") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.getAttribute("min")).toBe("0.01");
    expect(input.getAttribute("max")).toBe("10");
    expect(lastInput().riskProfile).toBe("CUSTOM");
    expect(lastInput().riskPercent).toBeCloseTo(1.25, 6);

    fireEvent.change(input, { target: { value: "2.5" } });
    expect(lastInput().riskPercent).toBeCloseTo(2.5, 6);
  });

  it("refuses an out-of-range custom risk instead of querying the backend", () => {
    render(<RiskCalculatorPanel />);
    fireEvent.click(screen.getByRole("radio", { name: /Custom/ }));
    fireEvent.change(screen.getByLabelText("Custom risk %"), { target: { value: "25" } });
    expect(lastInput().riskPercent).toBeNaN();
    expect(screen.getByText(/Enter a risk between 0.01% and 10%/)).toBeTruthy();
  });
});

describe("RiskCalculatorPanel · inputs", () => {
  it("collects direction, capital basis, and the levels for the broker calculation", () => {
    renderWithLevels();
    expect(lastInput().entryPrice).toBe(2350);
    expect(lastInput().stopLoss).toBe(2344);
    expect(lastInput().direction).toBe("BUY");
    expect(lastInput().basis).toBe("EQUITY");
    expect(lastInput().takeProfit).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "SELL" }));
    expect(lastInput().direction).toBe("SELL");

    fireEvent.change(screen.getByLabelText("Capital basis"), { target: { value: "BALANCE" } });
    expect(lastInput().basis).toBe("BALANCE");

    fireEvent.change(screen.getByLabelText("Take profit (optional)"), { target: { value: "2362" } });
    expect(lastInput().takeProfit).toBe(2362);
  });

  it("stops querying while the entry and stop are identical", () => {
    render(<RiskCalculatorPanel />);
    fireEvent.change(screen.getByLabelText("Entry price"), { target: { value: "2350" } });
    fireEvent.change(screen.getByLabelText("Stop loss"), { target: { value: "2350" } });
    expect(
      screen.getByText(/Select a risk profile, then enter an entry price and a different stop loss/)
    ).toBeTruthy();
  });
});

describe("RiskCalculatorPanel · results", () => {
  it("renders the deterministic risk dashboard and the no-execution badge", () => {
    mocks.data = calculation({ takeProfit: 2362 });
    renderWithLevels();

    // Labels repeat between the result cards and the maths trail, so every
    // assertion accepts one or more matches.
    const shown = (text: string) => expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    shown("No execution");
    shown("Risk amount");
    shown("$100.00");
    shown("Position size");
    shown("0.16 lots");
    shown("Actual risk");
    shown("$96.00");
    shown("Risk budget used");
    shown("96.0%");
    shown("Loss per lot");
    shown("$600.00");
    shown("Free margin");
    shown("$9,900.00");
    shown("1 : 2.00");
    shown("How this was calculated");
    shown("Broker calculation details");
    shown("XAUUSDm");
  });

  it("shows the safety warning when the broker minimum would exceed the selected risk", () => {
    mocks.data = calculation({ riskProfile: "CUSTOM", riskPercent: 0.03 });
    renderWithLevels();
    expect(screen.getByText("WARNING")).toBeTruthy();
    expect(
      screen.getByText(/The broker’s minimum volume would exceed your selected risk budget/)
    ).toBeTruthy();
    expect(screen.getByText(/Minimum executable risk: \$6\.00/)).toBeTruthy();
    expect(screen.getByText(/never raised to the broker minimum automatically/)).toBeTruthy();
  });

  it("shows a loading status while the broker request is in flight", () => {
    mocks.isLoading = true;
    mocks.data = undefined;
    renderWithLevels();
    expect(screen.getByText("Calculating broker risk…")).toBeTruthy();
  });

  it("shows the backend error instead of a fabricated result", () => {
    mocks.data = undefined;
    mocks.error = { message: "Supabase database is unavailable. Please retry shortly." };
    renderWithLevels();
    expect(screen.getByText("Risk data could not be calculated")).toBeTruthy();
    expect(screen.getByText(/Supabase database is unavailable/)).toBeTruthy();
  });

  it("shows broker data unavailable with no MT5 connection instead of a fake lot size", () => {
    mocks.data = calculateRisk(
      { basis: "EQUITY", riskProfile: "STANDARD", riskPercent: 1, direction: "BUY", ...levels },
      null,
      null
    );
    renderWithLevels();
    expect(screen.getByText("Broker risk data unavailable")).toBeTruthy();
    expect(screen.getByText("Connect MT5 to calculate broker-accurate position size.")).toBeTruthy();
    expect(screen.getByText(/Broker data is required for accurate position sizing/)).toBeTruthy();
    expect(screen.queryByText("Position size")).toBeNull();
  });
});

describe("RiskCalculatorPanel · AI independence", () => {
  it("renders and calculates when no AI key, settings, or provider exists", () => {
    // There is no AI module in this test's module graph at all.
    renderWithLevels();
    expect(screen.getByText("Risk amount")).toBeTruthy();
    expect(lastInput().riskPercent).toBe(1);
  });
});
