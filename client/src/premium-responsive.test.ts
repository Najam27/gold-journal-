import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Gold Journal is dark-only and has to stay usable from 320px up. These contract
 * tests read the sources the browser actually receives — the global stylesheet,
 * the premium layers, the HTML shell and the theme provider — because jsdom can
 * resolve neither media queries nor cascade order. Anything that re-introduces a
 * light palette, a fixed intrinsic track or a hidden-touch-target regression
 * fails here instead of quietly shipping.
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const indexCss = read("./index.css");
const interactionsCss = read("./premium-interactions.css");
const terminalCss = read("./premium-terminal.css");
const psychologyCss = read("./behavioral-psychology.css");
const indexHtml = read("../index.html");
const themeContext = read("./contexts/ThemeContext.tsx");
const shell = read("./pages/GoldJournal.tsx");

describe("dark-only theme", () => {
  it("attaches the authoritative palette to :root, not only to .dark", () => {
    expect(indexCss).toMatch(/:root,\s*\.dark \{/);
    expect(indexCss).toContain("color-scheme: dark;");
  });

  it("never leaves a native control on the OS light colour scheme", () => {
    for (const css of [indexCss, terminalCss, interactionsCss, psychologyCss]) {
      expect(css).not.toContain("color-scheme: light;");
    }
    expect(read("./uiux-system.css")).not.toContain("color-scheme: light;");
    expect(read("./theme-repair.css")).not.toContain("color-scheme: light;");
  });

  it("marks the retired light fallbacks as unreachable instead of leaving them live", () => {
    expect(indexCss).toContain("RETIRED LIGHT FALLBACKS");
  });

  it("applies the dark class before the bundle can paint", () => {
    expect(indexHtml).toContain('class="dark"');
    expect(indexHtml).toMatch(/classList\.add\("dark"\)/);
    // Pinch-zoom must stay available, so no maximum-scale lock.
    expect(indexHtml).not.toMatch(/maximum-scale\s*=/);
  });

  it("has no theme switcher left in the provider or the shell", () => {
    expect(themeContext).not.toContain('"light"');
    expect(themeContext).not.toContain("toggleTheme");
    expect(shell).not.toMatch(/Switch to (light|dark) theme/);
  });
});

describe("responsive contract", () => {
  it("defines the full ladder from tablet down to the smallest phone", () => {
    for (const step of ["@media (max-width: 1024px)", "@media (max-width: 760px)", "@media (max-width: 480px)", "@media (max-width: 400px)"]) {
      expect(interactionsCss).toContain(step);
    }
    for (const step of ["@media (max-width: 1100px)", "@media (max-width: 860px)", "@media (max-width: 700px)", "@media (max-width: 620px)", "@media (max-width: 460px)"]) {
      expect(psychologyCss).toContain(step);
    }
  });

  it("never lets an intrinsic track grow past its container", () => {
    expect(interactionsCss).toContain("minmax(min(100%, 17rem), 1fr)");
    expect(interactionsCss).toContain("minmax(min(100%, 17rem), .75fr)");
    expect(psychologyCss).toMatch(/@media \(min-width: 860px\) \{\s*\.dev-columns \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    expect(read("./mt5-live.css")).toContain("minmax(min(100%, 17.5rem), 1fr)");
  });

  it("gives every dense data surface its own scroll instead of widening the page", () => {
    for (const wrap of [".trade-table-wrap", ".control-table-wrap", ".mt5-table-wrap", ".edge-table-wrap", ".heatmap-table", ".pnl-week-calendar"]) {
      expect(interactionsCss).toContain(wrap);
    }
    expect(interactionsCss).toContain("overscroll-behavior-x: contain");
  });

  it("wraps long data and sizes charts from their container", () => {
    expect(interactionsCss).toContain("overflow-wrap: anywhere");
    expect(interactionsCss).toContain(".recharts-responsive-container");
  });

  it("grows touch targets for coarse pointers", () => {
    expect(interactionsCss).toContain("@media (hover: none), (pointer: coarse)");
    expect(interactionsCss).toContain("min-height: 2.5rem");
  });

  it("stacks the wide grids and the stat cards on the smallest screens", () => {
    expect(interactionsCss).toContain(".stats-grid.compact { grid-template-columns: minmax(0, 1fr); }");
    expect(interactionsCss).toContain(".goal-editor-grid");
  });

  it("steps the decorative 3D layer aside in short landscape viewports", () => {
    expect(interactionsCss).toContain("@media (max-height: 34rem) and (orientation: landscape)");
  });

  it("keeps the behavioural panel padded and its breakdown readable on a phone", () => {
    // The panel owns its padding, and the meter row reflows to two lines.
    expect(psychologyCss).toMatch(/\.dev-panel \{[^}]*padding: clamp\(/);
    expect(psychologyCss).toMatch(/\.dev-breakdown-row \{[^}]*min-width: 0/);
    expect(psychologyCss).toMatch(/@media \(max-width: 620px\) \{[\s\S]*\.dev-breakdown-row \{[\s\S]*flex-wrap: wrap/);
  });
});
