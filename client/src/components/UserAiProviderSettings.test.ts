import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./UserAiProviderSettings.tsx", import.meta.url)), "utf8");

describe("Options user AI provider settings", () => {
  it("keeps the raw key in a password field and delegates its lifecycle to protected server procedures", () => {
    expect(source).toContain('type="password"');
    expect(source).toContain("trpc.aiSettings.test.useMutation()");
    expect(source).toContain("trpc.aiSettings.save.useMutation()");
    expect(source).toContain("trpc.aiSettings.remove.useMutation()");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
  });
});
