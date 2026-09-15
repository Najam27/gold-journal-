// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.classList.remove("dark"); });
  afterEach(() => cleanup());

  it("honors an explicit light-theme preview request before the saved preference", () => {
    window.history.replaceState({}, "", "/?theme=light");
    localStorage.setItem("theme", "dark");
    render(<ThemeProvider defaultTheme="dark" switchable><ThemeToggle /></ThemeProvider>);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    window.history.replaceState({}, "", "/");
  });

  it("switches the document theme, persists the user selection, and retains semantic palette tokens", () => {
    const styles = readFileSync(resolve(process.cwd(), "client/src/index.css"), "utf8");
    const systemStyles = readFileSync(resolve(process.cwd(), "client/src/uiux-system.css"), "utf8");
    const repairStyles = readFileSync(resolve(process.cwd(), "client/src/theme-repair.css"), "utf8");
    expect(styles).toMatch(/:root\s*\{[\s\S]*?--gj-shell:\s*var\(--surface-base\)[\s\S]*?--gj-text:\s*var\(--text-primary\)/);
    expect(styles).toMatch(/\.dark\s*\{[\s\S]*?--gj-shell:\s*var\(--surface-base\)[\s\S]*?--gj-text:\s*var\(--text-primary\)/);
    expect(styles).toMatch(/:root\s*\{[\s\S]*?--profit:\s*var\(--state-profit\)[\s\S]*?--danger:\s*var\(--state-danger\)/);
    expect(styles).toMatch(/\.dark\s*\{[\s\S]*?--profit:\s*var\(--state-profit\)[\s\S]*?--danger:\s*var\(--state-danger\)/);
    expect(styles).toMatch(/:root\s*\{[\s\S]*?--gj-control-active:\s*var\(--surface-control-active\)[\s\S]*?--gj-control-focus:\s*rgba\(165,\s*108,\s*19,\s*0\.22\)/);
    expect(styles).toMatch(/\.dark\s*\{[\s\S]*?--gj-control-active:\s*var\(--surface-control-active\)[\s\S]*?--gj-control-focus:\s*rgba\(233,\s*182,\s*75,\s*0\.2\)/);
    expect(styles).toMatch(/--gj-subtle:\s*var\(--surface-subtle\)/);
    expect(styles).toMatch(/--gj-border:\s*var\(--border\)/);
    expect(systemStyles).toMatch(/--gj-chart-grid:[\s\S]*?--gj-fab-bottom:/);
    expect(systemStyles).toContain(".gj-shell select option");
    expect(systemStyles).toContain("var(--gj-control-option)");
    expect(systemStyles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(repairStyles).toContain(".mt5-connection-card");
    expect(repairStyles).toContain(".goal-card.met");
    expect(repairStyles).toContain(".gj-shell select option:checked");

    render(<ThemeProvider defaultTheme="dark" switchable><ThemeToggle /></ThemeProvider>);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    fireEvent.click(screen.getByTitle("Switch to light theme"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("theme")).toBe("light");
    fireEvent.click(screen.getByTitle("Switch to dark theme"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
  });
});
