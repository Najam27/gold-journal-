import type { Express, Request } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildMt5Endpoint, firstForwardedValue, renderMt5EaTemplate } from "./mt5EaCore";

export { EA_ENDPOINT_TOKEN, buildMt5Endpoint, firstForwardedValue, renderMt5EaTemplate } from "./mt5EaCore";

/**
 * Node-only EA template loader. The Cloudflare Worker bundles the same
 * template at build time (esbuild text loader) and renders it through
 * renderMt5EaTemplate(); the Node dev server reads it from disk.
 */
export function loadEaSourceFromDisk() {
  const candidates = [
    resolve(process.cwd(), "client/public/GoldJournal_EA.mq5"),
    resolve(process.env.LAMBDA_TASK_ROOT || "", "client/public/GoldJournal_EA.mq5"),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // The source-relative candidate is unavailable after bundling; continue
      // to the next candidate path.
    }
  }
  throw new Error("MT5 EA template is unavailable in this deployment.");
}

export function mt5EndpointForRequest(request: Request) {
  return buildMt5Endpoint({
    forwardedHost: request.headers["x-forwarded-host"],
    host: request.get("host") || "",
    forwardedProto: request.headers["x-forwarded-proto"],
    protocol: request.protocol === "https" ? "https" : "http",
  });
}

export function renderMt5EaForRequest(request: Request) {
  return renderMt5EaTemplate(loadEaSourceFromDisk(), mt5EndpointForRequest(request));
}

export function registerMt5EaDownload(app: Express, path = "/api/mt5/ea") {
  app.get(path, (request, response) => {
    try {
      const source = renderMt5EaForRequest(request);
      if (!source) {
        response.status(400).json({ ok: false, code: "MT5_ENDPOINT_UNAVAILABLE" });
        return;
      }
      response
        .status(200)
        .setHeader("Content-Type", "text/plain; charset=utf-8")
        .setHeader("Content-Disposition", 'attachment; filename="GoldJournal_EA.mq5"')
        .setHeader("Cache-Control", "no-store")
        .send(source);
    } catch {
      response.status(503).json({ ok: false, code: "MT5_EA_TEMPLATE_UNAVAILABLE" });
      return;
    }
  });
}
