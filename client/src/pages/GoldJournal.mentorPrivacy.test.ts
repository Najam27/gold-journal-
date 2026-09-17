import { describe, expect, it } from "vitest";
import { getMentorStorageKeys, MENTOR_LOCAL_KEY_NOTICE } from "./GoldJournal";

describe("AI Mentor public privacy notice", () => {
  it("explains the browser-only boundary without exposing an implementation storage key", () => {
    expect(MENTOR_LOCAL_KEY_NOTICE).toContain("stays in this browser only");
    expect(MENTOR_LOCAL_KEY_NOTICE).toContain("never sent to Gold Journal servers");
    expect(MENTOR_LOCAL_KEY_NOTICE).toContain("call Groq directly");
    expect(MENTOR_LOCAL_KEY_NOTICE).not.toMatch(/gemini|google ai|openrouter|openai/i);
    expect(MENTOR_LOCAL_KEY_NOTICE).not.toMatch(/localStorage|gj_/i);
  });

  it("does not create browser storage slots for provider credentials or reports", () => {
    expect(getMentorStorageKeys("auth-user-a")).toEqual({ storageKey: "", reportStorageKey: "" });
    expect(getMentorStorageKeys("auth-user-b")).toEqual({ storageKey: "", reportStorageKey: "" });
    expect(getMentorStorageKeys(null)).toEqual({ storageKey: "", reportStorageKey: "" });
  });
});
