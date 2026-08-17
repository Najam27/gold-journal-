import { describe, expect, it } from "vitest";
import { missingProductionConfiguration, validateRuntimeConfiguration } from "./env";

const configuredProductionEnvironment = {
  NODE_ENV: "production",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

describe("production runtime configuration", () => {
  it("fails fast in production when the Supabase service key is absent", () => {
    const environment = { ...configuredProductionEnvironment, SUPABASE_SERVICE_ROLE_KEY: "" };
    expect(missingProductionConfiguration(environment)).toEqual(["SUPABASE_SERVICE_ROLE_KEY"]);
    expect(() => validateRuntimeConfiguration(environment)).toThrow("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("permits development startup without production-only Supabase variables", () => {
    expect(missingProductionConfiguration({ NODE_ENV: "development" })).toEqual([]);
    expect(() => validateRuntimeConfiguration({ NODE_ENV: "development" })).not.toThrow();
  });
});
