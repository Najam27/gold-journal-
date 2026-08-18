import { describe, expect, it } from "vitest";
import { eq, gte, like, or, renderPostgrestFilter, supabaseDb } from "./supabaseQuery";

describe("Supabase query adapter transaction boundary", () => {
  it("does not expose a fake transaction method", () => {
    expect("transaction" in (supabaseDb as object)).toBe(false);
  });

  it("renders a bounded date lower bound", () => {
    expect(renderPostgrestFilter(gte({ name: "tradeDate" }, new Date("2026-01-01T00:00:00.000Z")))).toBe("tradeDate.gte.2026-01-01T00:00:00.000Z");
  });

  it("escapes compound filter delimiters without removing search wildcards", () => {
    const filter = or(eq({ name: "notes" }, 'A",evil,(x)\n'), like({ name: "notes" }, "%gold%"));
    const rendered = renderPostgrestFilter(filter as any);
    expect(rendered).toContain("notes.eq.A");
    expect(rendered).toContain("\\,evil");
    expect(rendered).toContain("\\(x\\)");
    expect(rendered).toContain("notes.ilike.%gold%");
    expect(rendered).not.toContain("\\n");
  });
});
