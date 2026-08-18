import { describe, expect, it } from "vitest";
import { hasImageSignature } from "./storage";

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
