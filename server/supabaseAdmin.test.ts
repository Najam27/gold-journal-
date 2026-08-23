import { afterEach, describe, expect, it } from "vitest";
import { supabaseDataSourceReference } from "./supabaseAdmin";

const initialUrl = process.env.SUPABASE_URL;

afterEach(() => {
  if (initialUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = initialUrl;
});

describe("Supabase data-source reference", () => {
  it("derives a deterministic non-secret tag from the configured URL", () => {
    const url = "https://project-ref.supabase.co";
    process.env.SUPABASE_URL = url;
    const reference = supabaseDataSourceReference();
    expect(reference).toMatch(/^gjsup-[a-f0-9]{12}$/);
    expect(reference).not.toContain(url);
    expect(reference).toBe(supabaseDataSourceReference());
  });

  it("does not manufacture a source tag without server configuration", () => {
    delete process.env.SUPABASE_URL;
    expect(supabaseDataSourceReference()).toBeNull();
  });
});
