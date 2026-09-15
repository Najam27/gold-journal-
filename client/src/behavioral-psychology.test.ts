import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The behavioural-psychology surfaces shipped without any stylesheet: the file
 * existed, nothing imported it, and commit 6daa6b9 deleted it as "unused". These
 * contract tests keep the Psychology page, the calendar day drill-down, and the
 * trade-dialog gate from silently going unstyled again.
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const psychologyCss = read("./behavioral-psychology.css");
const indexCss = read("./index.css");

describe("behavioural psychology stylesheet", () => {
  it("is imported by the global stylesheet, so the rules actually reach the browser", () => {
    expect(indexCss).toContain('@import "./behavioral-psychology.css";');
  });

  it("styles the Psychology page (trader development panel)", () => {
    const classNames = [
      ".dev-workspace",
      ".dev-header",
      ".dev-score",
      ".dev-stat-grid",
      ".dev-stat",
      ".dev-columns",
      ".dev-panel",
      ".dev-breakdown-row",
      ".dev-focus",
      ".dev-list",
      ".dev-cooldown",
      ".dev-readiness",
      ".dev-versus",
      ".dev-classification",
      ".dev-pnl-split",
      ".dev-streaks",
      ".dev-weekly",
      ".dev-weekly-summary",
      ".dev-insights",
      ".dev-identity",
      ".psychology-workspace",
    ];
    for (const className of classNames) expect(psychologyCss).toContain(className);
  });

  it("styles the calendar day drill-down, including the win/loss classification card", () => {
    expect(psychologyCss).toContain(".day-behavior {");
    expect(psychologyCss).toContain(".day-behavior-grid {");
    expect(psychologyCss).toContain(".day-behavior-card {");
    expect(psychologyCss).toContain(".day-behavior-card.safe");
    expect(psychologyCss).toContain(".day-behavior-card.risk");
    expect(psychologyCss).toContain(".day-behavior-lesson");
    expect(psychologyCss).toContain(".day-class-chip");
    expect(psychologyCss).toContain(".day-class-chip.safe");
    expect(psychologyCss).toContain(".day-class-chip.risk");
  });

  it("styles the trade gate, taxonomy, plan check-in, and cooldown banner", () => {
    for (const className of [
      ".behavior-banner",
      ".field-hint",
      ".plan-readiness",
      ".plan-rules-empty",
      ".gate-grid",
      ".gate-footer",
      ".plan-status-options",
      ".taxonomy-wrap",
      ".taxonomy-category",
      ".taxonomy-group",
      ".process-preview",
    ]) {
      expect(psychologyCss).toContain(className);
    }
  });

  it("uses theme tokens instead of fixed colours so light and dark stay readable", () => {
    expect(psychologyCss).toContain("var(--gj-line)");
    expect(psychologyCss).toContain("var(--gj-panel-2)");
    expect(psychologyCss).toContain("var(--gj-text)");
    expect(psychologyCss).toContain("var(--gj-subtext)");
    expect(psychologyCss).toContain("var(--success)");
    expect(psychologyCss).toContain("var(--destructive)");
    expect(psychologyCss).not.toMatch(/#(?:fff|ffffff|000|000000|111|101010)\b/i);
  });

  it("stacks every behavioural grid on a phone-sized viewport", () => {
    const mobile = psychologyCss.slice(psychologyCss.indexOf("@media (max-width: 700px)"));
    expect(mobile).toContain(".dev-stat-grid");
    expect(mobile).toContain(".dev-focus");
    expect(mobile).toContain(".dev-classifications");
    expect(mobile).toContain(".behavior-banner");
  });
});
