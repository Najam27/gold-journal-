import { describe, expect, it } from "vitest";
import { normalizeAccountName } from "./accountIdentity";

describe("normalizeAccountName", () => {
  it("uses a stable case-insensitive, whitespace-collapsed identity for the same visible account name", () => {
    expect(normalizeAccountName("  Blueberry   Live ")).toBe("blueberry live");
    expect(normalizeAccountName("BLUEBERRY LIVE")).toBe("blueberry live");
  });

  it("keeps distinct account names distinct without exposing database identifiers", () => {
    expect(normalizeAccountName("Blueberry Live")).not.toBe(normalizeAccountName("Blueberry Demo"));
  });
});
