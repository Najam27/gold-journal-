type RuntimeEnvironment = Record<string, string | undefined>;

const requiredProductionVariables = [
  "JWT_SECRET",
  "DATABASE_URL",
  "VITE_APP_ID",
  "OAUTH_SERVER_URL",
  "VITE_OAUTH_PORTAL_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export function missingProductionConfiguration(environment: RuntimeEnvironment = process.env) {
  if (environment.NODE_ENV !== "production") return [];
  return requiredProductionVariables.filter(name => !environment[name]?.trim());
}

export function validateRuntimeConfiguration(environment: RuntimeEnvironment = process.env) {
  const missing = missingProductionConfiguration(environment);
  if (missing.length) throw new Error(`Missing required environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
}

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
};
