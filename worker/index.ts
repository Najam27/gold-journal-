/**
 * Cloudflare Worker entry point.
 *
 * The router logic lives in ./router (imports no platform types), and the EA
 * template is inlined at build time by esbuild's text loader
 * (scripts/build-worker.mjs). `wrangler deploy` uploads the prebuilt
 * dist/worker/worker.js with the static frontend from dist/public as Worker
 * Assets, so the app and its API share one origin (free plan).
 */
import eaTemplateSource from "../client/public/GoldJournal_EA.mq5";
import { handleWorkerRequest, type WorkerEnv } from "./router";

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleWorkerRequest(request, env, eaTemplateSource);
  },
};
