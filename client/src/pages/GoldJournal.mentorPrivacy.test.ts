import { describe, expect, it } from "vitest";
import { MENTOR_LOCAL_KEY_NOTICE } from "./GoldJournal";

describe("AI Mentor public privacy notice", () => {
  it("explains the local-only boundary without exposing an implementation storage key", () => {
    expect(MENTOR_LOCAL_KEY_NOTICE).toContain("only in this browser");
    expect(MENTOR_LOCAL_KEY_NOTICE).toContain("never sent to the cloud journal");
    expect(MENTOR_LOCAL_KEY_NOTICE).not.toMatch(/localStorage|gj_/i);
  });
});
