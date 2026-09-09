import { describe, expect, it } from "vitest";
import { getAuthRedirectUrl } from "./authRedirect";

describe("Supabase auth redirect URL", () => {
  const local = { origin: "http://localhost:5173", pathname: "/" };

  it("uses an explicit deployed origin and removes query/hash fragments", () => {
    expect(getAuthRedirectUrl(local, "https://app.gold-journal.example/?from=email#callback")).toBe("https://app.gold-journal.example/");
  });

  it("falls back to the current origin and pathname for local development", () => {
    expect(getAuthRedirectUrl({ origin: "http://localhost:5173", pathname: "/journal" }, undefined)).toBe("http://localhost:5173/journal");
  });

  it("rejects unsafe or malformed redirect overrides", () => {
    expect(getAuthRedirectUrl(local, "javascript:alert(1)")).toBe("http://localhost:5173/");
    expect(getAuthRedirectUrl(local, "not a URL")).toBe("http://localhost:5173/");
  });
});
