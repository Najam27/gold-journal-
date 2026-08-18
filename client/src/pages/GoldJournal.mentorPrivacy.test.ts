import { describe, expect, it } from "vitest";
import { getMentorStorageKeys, MENTOR_LOCAL_KEY_NOTICE } from "./GoldJournal";

describe("AI Mentor public privacy notice", () => {
  it("explains the local-only boundary without exposing an implementation storage key", () => {
    expect(MENTOR_LOCAL_KEY_NOTICE).toContain("only in this browser");
    expect(MENTOR_LOCAL_KEY_NOTICE).toContain("never sent to the cloud journal");
    expect(MENTOR_LOCAL_KEY_NOTICE).not.toMatch(/localStorage|gj_/i);
  });

  it("scopes provider keys and reports to the authenticated user", () => {
    const userA = getMentorStorageKeys("auth-user-a");
    const userB = getMentorStorageKeys("auth-user-b");
    expect(userA.storageKey).not.toBe(userB.storageKey);
    expect(userA.reportStorageKey).not.toBe(userB.reportStorageKey);
    expect(getMentorStorageKeys(null)).toEqual({ storageKey: "", reportStorageKey: "" });
  });
});
