#!/usr/bin/env node
// =====================================================================
// Gold Journal — build-time environment injection
// ---------------------------------------------------------------------
// Reads SUPABASE_URL and SUPABASE_ANON_KEY from the environment and
// writes them into js/env.js, which the app loads before anything else.
//
// - On Netlify, the variables come from Site Settings -> Environment
//   Variables and are available to this build command.
// - For local development, values are read from a .env file (see
//   .env.example). The .env file is git-ignored and never committed.
//
// The generated js/env.js is also git-ignored: secrets/config are
// injected at BUILD time and never hardcoded into any source file.
// =====================================================================

const fs = require("fs");
const path = require("path");

// --- Load .env for local dev (Netlify injects vars into process.env) ---
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const rawLine of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    "[build] WARNING: SUPABASE_URL and/or SUPABASE_ANON_KEY are not set. " +
      "The deployed app will show a configuration-error screen until they are provided."
  );
}

const out =
  "// AUTO-GENERATED at build time by build.js — DO NOT edit or commit.\n" +
  "// Populated from environment variables (Netlify / local .env).\n" +
  "window.__GJ_SUPABASE_URL__ = " +
  JSON.stringify(SUPABASE_URL) +
  ";\n" +
  "window.__GJ_SUPABASE_ANON_KEY__ = " +
  JSON.stringify(SUPABASE_ANON_KEY) +
  ";\n";

const outPath = path.join(__dirname, "js", "env.js");
fs.writeFileSync(outPath, out);
console.log("[build] Wrote " + path.relative(__dirname, outPath));
