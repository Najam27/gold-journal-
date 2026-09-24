import { describe, expect, it } from "vitest";
import { getMentorStorageKeys, MENTOR_LOCAL_KEY_NOTICE } from "./GoldJournal";

describe("AI Mentor public privacy notice", () => {
  it("explains the browser-only boundary for both providers without exposing an implementation storage key", () => {
    expect(MENTOR_LOCAL_KEY_NOTICE).toContain("stay in this browser only");
    expect(MENTOR_LOCAL_KEY_NOTICE).toContain("never sent to Gold Journal servers");
    // Both supported providers are named, and the notice says the keys are read
    // only to call the provider the user configured from this device.
    expect(MENTOR_LOCAL_KEY_NOTICE).toMatch(/Gemini and Groq/);
    expect(MENTOR_LOCAL_KEY_NOTICE).toContain("provider you configured directly from this device");
    // Providers this app does not offer are still never named.
    expect(MENTOR_LOCAL_KEY_NOTICE).not.toMatch(/openrouter|openai|anthropic/i);
    expect(MENTOR_LOCAL_KEY_NOTICE).not.toMatch(/localStorage|gj_/i);
  });

  it("does not create browser storage slots for provider credentials or reports", () => {
    expect(getMentorStorageKeys("auth-user-a")).toEqual({ storageKey: "", reportStorageKey: "" });
    expect(getMentorStorageKeys("auth-user-b")).toEqual({ storageKey: "", reportStorageKey: "" });
    expect(getMentorStorageKeys(null)).toEqual({ storageKey: "", reportStorageKey: "" });
  });
});
