// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TradeEnvironmentSwitch from "@/components/TradeEnvironmentSwitch";

afterEach(cleanup);

describe("TradeEnvironmentSwitch", () => {
  it("renders Live and Testing options with the current one active", () => {
    render(<TradeEnvironmentSwitch value="LIVE" onChange={() => {}} />);
    const live = screen.getByRole("button", { name: "Live" });
    const testing = screen.getByRole("button", { name: "Testing" });
    expect(live.getAttribute("aria-pressed")).toBe("true");
    expect(testing.getAttribute("aria-pressed")).toBe("false");
    expect(live.className).toContain("active");
    expect(testing.className).not.toContain("active");
  });

  it("marks Testing active when selected", () => {
    const { container } = render(<TradeEnvironmentSwitch value="TESTING" onChange={() => {}} />);
    expect((container.firstChild as HTMLElement).getAttribute("data-env")).toBe("TESTING");
    expect(screen.getByRole("button", { name: "Testing" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("calls onChange with TESTING when the Testing button is clicked", () => {
    const onChange = vi.fn();
    render(<TradeEnvironmentSwitch value="LIVE" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Testing" }));
    expect(onChange).toHaveBeenCalledWith("TESTING");
  });

  it("does not call onChange when the already-active option is clicked", () => {
    const onChange = vi.fn();
    render(<TradeEnvironmentSwitch value="LIVE" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
