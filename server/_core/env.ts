type RuntimeEnvironment = Record<string, string | undefined>;

const requiredProductionVariables = [
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
  supabaseUrl: process.env.SUPABASE_URL ?? "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.OPENAI_API_BASE ?? process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.OPENAI_API_KEY ?? process.env.BUILT_IN_FORGE_API_KEY ?? "",
};
