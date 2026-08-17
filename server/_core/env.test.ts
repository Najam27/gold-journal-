import { describe, expect, it } from "vitest";
import { missingProductionConfiguration, validateRuntimeConfiguration } from "./env";

const configuredProductionEnvironment = {
  NODE_ENV: "production",
  JWT_SECRET: "test-secret",
  DATABASE_URL: "postgresql://example.test/journal",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  VITE_APP_ID: "app-id",
  OAUTH_SERVER_URL: "https://oauth.example.test",
  VITE_OAUTH_PORTAL_URL: "https://portal.example.test",
};

describe("production runtime configuration", () => {
  it("fails fast in production when the JWT signing secret is absent without exposing a value", () => {
    const environment = { ...configuredProductionEnvironment, JWT_SECRET: "" };
    expect(missingProductionConfiguration(environment)).toEqual(["JWT_SECRET"]);
    expect(() => validateRuntimeConfiguration(environment)).toThrow("JWT_SECRET");
  });

  it("permits development startup without production-only platform variables", () => {
    expect(missingProductionConfiguration({ NODE_ENV: "development" })).toEqual([]);
    expect(() => validateRuntimeConfiguration({ NODE_ENV: "development" })).not.toThrow();
  });
});
