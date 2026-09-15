import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./GoldJournal.tsx", import.meta.url)),
  "utf8"
);

describe("Gold Journal sidebar routes", () => {
  it("keeps MT5 Live and Risk Calculator as distinct navigation destinations", () => {
    expect(source).toContain('{ id: "mt5", label: "MT5 Live"');
    expect(source).toContain('{ id: "risk", label: "Risk Calculator"');
    expect(source).toMatch(/view === "mt5" &&\s*\(\s*<Mt5LiveView/);
    expect(source).toMatch(/view === "risk" &&\s*<RiskCalculatorPanel/);
    expect(source).not.toMatch(/view === "mt5" &&\s*<RiskCalculatorPanel/);
    expect(source).not.toMatch(/view === "risk" &&\s*\(\s*<Mt5LiveView/);
  });

  it("gives trader-development psychology its own destination instead of nesting it in Goals", () => {
    expect(source).toContain('{ id: "psychology", label: "Psychology", icon: Brain }');
    expect(source).toMatch(/view === "psychology" &&\s*\([\s\S]*?<TraderDevelopmentPanel/);
    // The Goals page must no longer own the behavioural report or the identity
    // statement: those inputs now belong to the Psychology route.
    const goalsView = source.slice(source.indexOf('view === "goals" &&'), source.indexOf('view === "psychology" &&'));
    expect(goalsView).toContain("<GoalsView");
    expect(goalsView).not.toContain("report={development}");
    expect(goalsView).not.toContain("onSaveIdentity");
    expect(goalsView).not.toContain("identityStatement");
    // The cooldown banner routes there, and the Goals desk links across.
    expect(source).toContain('onClick={() => setView("psychology")}>Review development');
    const goalsDesk = readFileSync(
      fileURLToPath(new URL("../components/FlexibleGoalsView.tsx", import.meta.url)),
      "utf8"
    );
    expect(goalsDesk).toContain('openJournalView("psychology")');
    expect(goalsDesk).not.toContain("TraderDevelopmentPanel");
  });

  it("keeps Psychology reachable from the phone bar as well as the sidebar", () => {
    expect(source).toContain('const mobileNavIds: View[] = ["trades", "analysis", "goals", "psychology", "calendar", "mt5"];');
    expect(source).toMatch(/mobileNavIds\s*\.map\(id => navItems\.find/);
    expect(source).not.toContain("navItems.slice(0, 5)");
  });
});
