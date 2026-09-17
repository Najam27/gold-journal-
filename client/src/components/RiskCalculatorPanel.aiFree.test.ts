import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard rails for the decoupling itself.
 *
 * The Risk Calculator must keep working with no AI key, no AI settings, an
 * unavailable provider model, and no internet. These assertions fail loudly if
 * anyone re-introduces a runtime dependency on the AI subsystem, so the
 * regression cannot come back silently through a refactor.
 */

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const PANEL = read("./RiskCalculatorPanel.tsx");
const ENGINE = read("../../../shared/riskCalculator.ts");

describe("Risk Calculator is AI-independent", () => {
  it("imports nothing from the AI subsystem", () => {
    expect(PANEL).not.toMatch(/from "@\/lib\/ai/);
    expect(PANEL).not.toMatch(/@shared\/aiCore/);
  });

  it("never references the removed AI risk-coach surface", () => {
    expect(PANEL).not.toMatch(/coachRisk|AiRiskCoachOutcome|AI_UI_COPY|useAiSettings|uiStateForErrorCode/);
    expect(PANEL).not.toMatch(/\bBot\b/);
  });

  it("never references a provider name or a provider key prompt", () => {
    expect(PANEL).not.toMatch(/Groq|Google AI|Gemini|API key|Open Options|Reviewing in your browser/i);
  });

  it("keeps the deterministic engine free of any AI dependency", () => {
    expect(ENGINE).not.toMatch(/groq|gemini|@shared\/aiCore|@\/lib\/ai|coachRisk|useAiSettings/i);
  });
});
