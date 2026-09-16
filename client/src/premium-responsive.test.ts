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

  it("stacks the stat cards before they squeeze, but never below 400px", () => {
    expect(interactionsCss).toContain("@media (min-width: 401px) and (max-width: 1150px)");
  });
});

describe("sidebar shell", () => {
  it("is fixed to the viewport and scrolls internally", () => {
    expect(interactionsCss).toMatch(/\.gj-sidebar \{[^}]*position: fixed/);
    expect(interactionsCss).toMatch(/\.gj-sidebar \{[^}]*overflow-y: auto/);
    expect(interactionsCss).toMatch(/\.gj-sidebar \{[^}]*overscroll-behavior: contain/);
  });

  it("collapses to the rail on desktop only, and moves the page with it", () => {
    // The rail state must not leak into the drawer range.
    expect(indexCss).toMatch(/@media \(min-width: 1024px\) \{ \.gj-sidebar\.is-collapsed/);
    expect(interactionsCss).toContain(".gj-shell:has(> .gj-sidebar.is-collapsed) .gj-main { margin-left: var(--gj-sidebar-rail); }");
  });

  it("neutralises the retired 761–1120px forced icon rail instead of leaving it live", () => {
    // `index.css` sits past the editor's patch window, so the superseded block is
    // undone from the last-loaded layer at equal specificity — later wins.
    expect(indexCss).toContain("@media (max-width: 1120px) { .gj-main { margin-left: 76px;");
    expect(interactionsCss).toContain("RETIRED RAIL RULES, NEUTRALISED");
    expect(interactionsCss).toContain(".gj-sidebar .brand-copy { display: grid; }");
    const restore = interactionsCss.indexOf(".gj-sidebar .collapse-button { display: grid; }");
    expect(restore).toBeGreaterThan(interactionsCss.indexOf("@media (min-width: 1024px) { .gj-shell:has"));
    // …and the drawer's 0-3-0 `.gj-shell .gj-sidebar .collapse-button` still
    // hides the restored 0-2-0 toggle below 1024px (asserted above).
  });

  it("becomes an off-canvas drawer under 1024px with a way out", () => {
    expect(interactionsCss).toMatch(/@media \(max-width: 1023px\) \{[\s\S]*?\.gj-sidebar\.is-open[^{]*\{ transform: translateX\(0\); \}/);
    expect(interactionsCss).toMatch(/@media \(max-width: 1023px\) \{[\s\S]*\.drawer-scrim \{/);
    expect(interactionsCss).toMatch(/@media \(max-width: 1023px\) \{[\s\S]*\.mobile-topbar \{/);
    // The rail toggle is meaningless off-canvas; an explicit exit replaces it.
    expect(interactionsCss).toMatch(/@media \(max-width: 1023px\) \{[\s\S]*\.collapse-button \{ display: none; \}/);
    expect(shell).toContain('className="drawer-close"');
    expect(shell).toContain('aria-label="Close navigation"');
  });

  it("opens the drawer at full width even while the rail preference is collapsed", () => {
    // `.gj-sidebar.is-collapsed { width: 76px }` is 0-2-0 in two earlier layers,
    // so it beat the drawer's 0-1-0 width and left a 76px sliver behind the
    // scrim — a menu that was technically open and completely unusable.
    expect(interactionsCss).toMatch(/@media \(max-width: 1023px\) \{[\s\S]*\.gj-shell \.gj-sidebar\.is-collapsed \{[\s\S]*?width: min\(20rem, 86vw\);/);
    expect(interactionsCss).toMatch(/@media \(max-width: 1023px\) \{[\s\S]*\.gj-shell \.gj-sidebar\.is-collapsed\.is-open \{ transform: translateX\(0\); \}/);
  });

  it("remembers the rail and closes the drawer on Escape without a scroll lock leaking", () => {
    expect(shell).toContain('window.localStorage.getItem("gj:sidebar-rail")');
    expect(shell).toContain('window.localStorage.setItem("gj:sidebar-rail"');
    expect(shell).toMatch(/event\.key === "Escape"/);
    expect(shell).toContain('document.body.style.overflow = "hidden";');
    expect(shell).toContain('window.addEventListener("resize", closeOnWideViewport)');
  });

  it("reserves the fixed action stack instead of letting it cover the last row", () => {
    expect(interactionsCss).toMatch(/\.gj-main \{[^}]*padding-bottom: 12rem/);
    expect(interactionsCss).toContain(".gj-main { padding-bottom: 14rem; }");
  });
});

describe("Trade Log account strip", () => {
  const strip = read("./components/premium/AccountStatusStrip.tsx");

  it("shows the account name and the connection states, and nothing else", () => {
    expect(shell).toContain("AccountStatusStrip");
    expect(shell).not.toContain("AccountHero");
    expect(shell).not.toContain("LIVE ACCOUNT OVERVIEW");
    expect(strip).toContain("MT5 connected");
    expect(strip).toContain("MT5 not connected");
    expect(strip).toContain("Cloud synced");
    expect(strip).toContain("Offline — local data");
    // A status line, not a dashboard: no metrics, no 3D surface, no tilt.
    expect(strip).not.toContain("AnimatedNumber");
    expect(strip).not.toContain("Premium3DBackground");
    expect(strip).not.toContain("TiltCard");
  });

  it("takes the hero surface out of the stylesheet with the component", () => {
    expect(terminalCss).not.toContain(".hero-metric");
    expect(terminalCss).not.toContain(".account-hero-floating");
    expect(terminalCss).not.toContain("DASHBOARD HERO");
    expect(interactionsCss).toContain(".account-strip {");
    expect(interactionsCss).toContain(".connection-pill.profit");
    expect(interactionsCss).toContain(".connection-pill.loss");
  });
});

describe("brand mark", () => {
  const markSvg = read("../public/gold-journal-3d.svg");
  const manifest = read("../public/manifest.json");
  const serviceWorker = read("../public/sw.js");

  it("is the 3D bullion mark everywhere the brand appears", () => {
    expect(shell).toContain('const logoUrl = "/gold-journal-3d.svg";');
    expect(indexHtml).toContain('rel="icon" type="image/svg+xml" href="/gold-journal-3d.svg"');
    expect(indexHtml).toContain('rel="apple-touch-icon" href="/gold-journal-3d.svg"');
    expect(manifest).toContain('"/gold-journal-3d.svg"');
    expect(manifest).not.toContain("gold-journal-mark.svg");
    expect(serviceWorker).toContain('"/gold-journal-3d.svg"');
  });

  it("renders depth with layered gradients rather than a flat glyph", () => {
    expect(markSvg).toContain('viewBox="0 0 512 512"');
    expect(markSvg).toContain('aria-label="Gold Journal"');
    // Face, edge slab, rim light and a blurred shadow = 3D, no bitmap needed.
    for (const layer of ["gjFace", "gjEdge", "gjRim", "gjBlur"]) expect(markSvg).toContain(`id="${layer}"`);
    expect(markSvg).toContain("filter=\"url(#gjBlur)\"");
  });
});
