import { describe, expect, it, vi } from "vitest";
import { hydrateSignedScreenshots } from "./journalScreenshots";

describe("hydrateSignedScreenshots", () => {
  it("keeps the journal usable when one screenshot signer is unavailable", async () => {
    const sign = vi.fn(async (key: string) => { if (key === "broken") throw new Error("Storage unavailable"); return `signed:${key}`; });
    await expect(hydrateSignedScreenshots([{ id: 1, screenshotKey: "ready" }, { id: 2, screenshotKey: "broken" }, { id: 3, screenshotKey: null }], sign)).resolves.toEqual([{ id: 1, screenshotKey: "ready", screenshotUrl: "signed:ready" }, { id: 2, screenshotKey: "broken", screenshotUrl: null }, { id: 3, screenshotKey: null, screenshotUrl: null }]);
  });

  it("bounds a stalled signer rather than blocking the whole journal", async () => {
    const never = () => new Promise<string>(() => {});
    await expect(hydrateSignedScreenshots([{ id: 1, screenshotKey: "slow" }], never, 1)).resolves.toEqual([{ id: 1, screenshotKey: "slow", screenshotUrl: null }]);
  });
});
