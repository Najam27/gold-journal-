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

  it("caps simultaneous signing work for large dashboard batches", async () => {
    let active = 0;
    let peak = 0;
    const sign = async (key: string) => { active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active -= 1; return `signed:${key}`; };
    const rows = Array.from({ length: 40 }, (_, id) => ({ id, screenshotKey: `key-${id}` }));
    await expect(hydrateSignedScreenshots(rows, sign, 1_000, 8)).resolves.toHaveLength(40);
    expect(peak).toBeLessThanOrEqual(8);
  });
});
