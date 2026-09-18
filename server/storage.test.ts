import { describe, expect, it } from "vitest";
import { hasImageSignature, isOwnedScreenshotPath, screenshotObjectKey, screenshotPathPrefix } from "./storage";

describe("screenshot content validation", () => {
  it("accepts the supported image magic bytes", () => {
    expect(hasImageSignature(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toBe(true);
    expect(hasImageSignature(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png")).toBe(true);
    expect(hasImageSignature(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]), "image/webp")).toBe(true);
  });

  it("rejects content that only claims to be an image", () => {
    expect(hasImageSignature(new TextEncoder().encode("#!/bin/sh\necho unsafe"), "image/png")).toBe(false);
    expect(hasImageSignature(Uint8Array.from([0xff, 0xd8, 0xff]), "image/png")).toBe(false);
  });
});

/**
 * Screenshot storage security.
 *
 * The object key is the one part of the screenshot lifecycle the browser can
 * influence (it sends the key back with a trade), so the ownership rule has to
 * hold at that boundary: an image can only ever be attached to a trade inside
 * the caller's own identity AND their own account.
 */
describe("screenshot storage path ownership", () => {
  const uid = "2f1c6f0e-0f6d-4a4b-9d2f-1234567890ab";

  it("builds keys whose first folder is the Supabase auth uid the bucket policy authorizes on", () => {
    const key = screenshotObjectKey({ authUid: uid, accountId: 12, tradeRef: "abc123", extension: "png", draft: true });
    // supabase/migrations/0002 authorizes on `(storage.foldername(name))[1]`.
    expect(key.startsWith(`${uid}/`)).toBe(true);
    expect(screenshotPathPrefix(uid, 12)).toBe(`${uid}/accounts/12/trades/`);
    expect(key).toMatch(new RegExp(`^${uid}/accounts/12/trades/draft-abc123/[a-f0-9]+\.png$`));
    // A committed trade keys on its own id instead of the mutation id.
    expect(screenshotObjectKey({ authUid: uid, accountId: 12, tradeRef: 77, extension: "jpg" })).toMatch(new RegExp(`^${uid}/accounts/12/trades/77/[a-f0-9]+\.jpg$`));
  });

  it("accepts only keys inside the caller's own account folder", () => {
    expect(isOwnedScreenshotPath(`${uid}/accounts/12/trades/7/evidence.png`, uid, 12)).toBe(true);
    // Another account of the same identity.
    expect(isOwnedScreenshotPath(`${uid}/accounts/13/trades/7/evidence.png`, uid, 12)).toBe(false);
    // Another identity entirely, including the legacy constant first folder.
    expect(isOwnedScreenshotPath(`someone-else/accounts/12/trades/7/evidence.png`, uid, 12)).toBe(false);
    expect(isOwnedScreenshotPath(`gold-journal/${uid}/trades/7-evidence.png`, uid, 12)).toBe(false);
    // A prefix that never reaches the account segment.
    expect(isOwnedScreenshotPath(`${uid}/accounts/1/trades/7/evidence.png`, uid, 12)).toBe(false);
  });

  it("rejects traversal, control characters, and an absent identity or account", () => {
    expect(isOwnedScreenshotPath(`${uid}/accounts/12/trades/../../etc/passwd`, uid, 12)).toBe(false);
    expect(isOwnedScreenshotPath(`${uid}/accounts/12/trades/7/a\u0000b.png`, uid, 12)).toBe(false);
    expect(isOwnedScreenshotPath(`${uid}/accounts/12/trades/7/${"a".repeat(600)}.png`, uid, 12)).toBe(false);
    expect(isOwnedScreenshotPath(`${uid}/accounts/12/trades/7/evidence.png`, null, 12)).toBe(false);
    expect(isOwnedScreenshotPath(`${uid}/accounts/12/trades/7/evidence.png`, uid, undefined as unknown as number)).toBe(false);
    expect(isOwnedScreenshotPath(undefined, uid, 12)).toBe(false);
  });

  it("refuses to accept an absolute URL, so an expiring signed URL can never be persisted", () => {
    expect(isOwnedScreenshotPath(`https://storage.example/${uid}/accounts/12/trades/7/evidence.png`, uid, 12)).toBe(false);
  });
});
