import { describe, expect, it } from "vitest";
import { and, eq, gte, like, or, renderPostgrestFilter, supabaseDb } from "./supabaseQuery";

describe("Supabase query adapter transaction boundary", () => {
  it("does not expose a fake transaction method", () => {
    expect("transaction" in (supabaseDb as object)).toBe(false);
  });

  it("renders a bounded date lower bound", () => {
    expect(renderPostgrestFilter(gte({ name: "tradeDate" }, new Date("2026-01-01T00:00:00.000Z")))).toBe("tradeDate.gte.2026-01-01T00:00:00.000Z");
  });

  it("escapes compound filter delimiters without removing search wildcards", () => {
    const unsafe = 'A",evil,(x)' + "\n\r\\";
    const filter = or(eq({ name: "notes" }, unsafe), like({ name: "notes" }, "%gold%"));
    const rendered = renderPostgrestFilter(filter as any);
    expect(rendered).toContain("notes.eq.A");
    expect(rendered).toContain("\\,evil");
    expect(rendered).toContain("\\(x\\)");
    expect(rendered).toContain("\\\\,");
    expect(rendered).toContain("notes.ilike.%gold%");
    expect(rendered).not.toContain("\\n");
    expect(rendered).not.toContain("\\r");
  });

  it("preserves nested boolean grouping and normalizes null, Date, and bigint values", () => {
    const nested = and(or(eq({ name: "userId" }, 7), eq({ name: "userId" }, 8)), gte({ name: "tradeDate" }, new Date("2026-01-01T00:00:00.000Z")));
    expect(renderPostgrestFilter(nested as any)).toBe("and(or(userId.eq.7,userId.eq.8),tradeDate.gte.2026-01-01T00:00:00.000Z)");
    expect(renderPostgrestFilter(eq({ name: "deletedAt" }, null) as any)).toBe("deletedAt.is.null");
    expect(renderPostgrestFilter(eq({ name: "ticket" }, 42n) as any)).toBe("ticket.eq.42");
  });
});
