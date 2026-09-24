import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./UserAiProviderSettings.tsx", import.meta.url)), "utf8");

describe("Options user AI provider settings", () => {
  it("keeps the raw key in a password field and never routes it through the backend", () => {
    expect(source).toContain('type="password"');
    expect(source).not.toContain("trpc");
    expect(source).not.toContain("useMutation");
    expect(source).not.toContain("aiSettings.");
  });

  it("stores every credential in browser-local storage through the AI storage layer", () => {
    expect(source).toContain("saveProviderSettings");
    expect(source).toContain("clearProviderSettings");
    expect(source).toContain("readAiProviderBundle");
    expect(source).toContain("@/lib/ai/aiStorage");
    expect(source).not.toContain("sessionStorage");
  });

  it("explains that local storage is readable by page scripts", () => {
    expect(source).toContain("Local storage is readable by JavaScript running on this site.");
  });

  it("offers both Gemini and Groq, each with a real connection test", () => {
    expect(source).toContain('(["gemini", "groq"] as const)');
    expect(source).toContain("testProviderConnection");
    expect(source).toContain("ProviderConnectionStatus");
    expect(source).toContain("AI_PROVIDER_META");
    expect(source).toContain("ai-provider-card");
    expect(source).not.toMatch(/openrouter|anthropic/i);
  });

  it("states the automatic fallback and the deterministic safety net", () => {
    expect(source).toMatch(/falls back automatically/);
    expect(source).toMatch(/deterministic\s+report is still shown/);
  });

  it("offers only the models the key can actually call, and never renders or URL-carries the raw key", () => {
    expect(source).toContain("availableModels");
    // The saved credential is only ever shown masked.
    expect(source).toContain("maskedKey");
    expect(source).not.toContain("?key=");
  });
});
