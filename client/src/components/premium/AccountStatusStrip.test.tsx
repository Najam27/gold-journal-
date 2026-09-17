// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStatusStrip } from "./AccountStatusStrip";

const mount = (mt5Connection?: unknown) =>
  render(<AccountStatusStrip accountName="Primary" mt5Connection={mt5Connection as any} online syncing={false} />);

const mt5Pill = () => screen.getByText(/^MT5 |^Waiting for MT5/).closest(".connection-pill") as HTMLElement;

describe("Trade Log account status strip · MT5 signal", () => {
  afterEach(() => cleanup());

  it("reports no MT5 link when the account has no connection record", () => {
    mount(undefined);
    expect(screen.getByText("MT5 not connected")).toBeTruthy();
    expect(mt5Pill().className).toContain("loss");
  });

  it("only claims a connection while the terminal contact is current", () => {
    mount({ active: true, syncHealth: { state: "CONNECTED", label: "MT5 connected", message: "Live terminal contact and account snapshot are current." } });
    expect(screen.getByText("MT5 connected")).toBeTruthy();
    expect(mt5Pill().className).toContain("profit");
    expect(mt5Pill().getAttribute("title")).toContain("Live terminal contact");
  });

  it("never shows a linked but silent terminal as connected", () => {
    mount({ active: true, syncHealth: { state: "WAITING", label: "Waiting for MT5", message: "Waiting for the first MT5 terminal contact." } });
    expect(screen.queryByText("MT5 connected")).toBeNull();
    expect(screen.getByText("Waiting for MT5")).toBeTruthy();
    expect(mt5Pill().className).toContain("warn");
  });

  it("treats a connection record with no health yet as waiting rather than connected", () => {
    mount({ active: true });
    expect(screen.queryByText("MT5 connected")).toBeNull();
    expect(screen.getByText("Waiting for MT5")).toBeTruthy();
  });

  it("surfaces an offline terminal, a stale sync, and a rejected key in their own words", () => {
    const cases: Array<[string, string, string]> = [
      ["OFFLINE", "MT5 offline", "loss"],
      ["STALE", "MT5 sync stale", "warn"],
      ["DEGRADED", "MT5 sync degraded", "warn"],
      ["AUTH_ERROR", "MT5 key rejected", "loss"],
      ["CONFIG_ERROR", "MT5 configuration invalid", "loss"],
    ];
    for (const [state, label, tone] of cases) {
      const { unmount } = mount({ active: true, syncHealth: { state, label, message: `${label} detail.` } });
      expect(screen.queryByText("MT5 connected")).toBeNull();
      expect(screen.getByText(label)).toBeTruthy();
      expect(mt5Pill().className).toContain(tone);
      expect(mt5Pill().getAttribute("title")).toBe(`${label} detail.`);
      unmount();
    }
  });

  it("keeps the cloud signal independent of the MT5 signal", () => {
    render(<AccountStatusStrip accountName="Primary" mt5Connection={{ active: true, syncHealth: { state: "OFFLINE", label: "MT5 offline" } }} online={false} syncing />);
    expect(screen.getByText("Offline — local data")).toBeTruthy();
    expect(screen.getByText("MT5 offline")).toBeTruthy();
    expect(screen.getByText("Syncing")).toBeTruthy();
  });
});
