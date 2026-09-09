/**
 * Builds the Cloudflare Worker bundle (dist/worker/worker.js).
 *
 * - bundles worker/index.ts for the workerd runtime (browser platform)
 * - inlines client/public/GoldJournal_EA.mq5 as text (esbuild text loader)
 * - verifies the EA template actually landed in the bundle and that no
 *   Node-only server glue leaked in, so `wrangler deploy` never ships a
 *   worker without the MT5 EA download or with a server-only import.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = resolve(root, "dist/worker/worker.js");

mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(root, "worker/index.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  loader: { ".mq5": "text" },
  // Node built-ins are provided at runtime by the nodejs_compat flag; never
  // bundle them into the worker. The list mirrors what server modules import
  // (keep in sync if a new server module adds a built-in).
  external: ["node:crypto", "node:buffer", "node:stream", "node:timers", "node:util", "node:string_decoder"],
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

const bundle = readFileSync(outfile, "utf8");

const failures = [];
if (!bundle.includes("HasConfiguredEndpoint")) failures.push("MT5 EA template text is missing from the Worker bundle (check the .mq5 text loader).");
if (!bundle.includes("__GOLD_JOURNAL_MT5_ENDPOINT__")) failures.push("MT5 EA endpoint token is missing from the Worker bundle (check the .mq5 text loader).");
if (bundle.includes("node:fs") || bundle.includes('from "express"')) failures.push("Worker bundle contains Node-only glue (express / node:fs). The Worker entry must only import platform-neutral server modules.");
if (failures.length > 0) {
  for (const failure of failures) console.error(`[worker-build] ${failure}`);
  process.exit(1);
}

const sizeKb = Math.round(bundle.length / 1024);
console.log(`[worker-build] dist/worker/worker.js written (${sizeKb} KB, EA template inlined and verified).`);
writeFileSync(resolve(root, "dist/worker/.build-size"), String(sizeKb));
