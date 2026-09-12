import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./UserAiProviderSettings.tsx", import.meta.url)), "utf8");

describe("Options user AI provider settings", () => {
  it("keeps the raw key in a password field and never routes it through the backend", () => {
    expect(source).toContain('type="password"');
    expect(source).not.toContain("trpc");
    expect(source).not.toContain("aiSettings.");
    expect(source).not.toContain("useMutation");
  });

  it("stores the credential in browser-local storage through the AI storage layer", () => {
    expect(source).toContain("saveAiSettings");
    expect(source).toContain("clearAiSettings");
    expect(source).toContain("@/lib/ai/aiStorage");
    expect(source).not.toContain("sessionStorage");
  });

  it("explains that local storage is readable by page scripts", () => {
    expect(source).toContain("Local storage is readable by JavaScript running on this site.");
  });
});
