import type { Express, Request } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EA_ENDPOINT_TOKEN = "__GOLD_JOURNAL_MT5_ENDPOINT__";
function loadEaSource() {
  const candidates = [
    resolve(process.cwd(), "client/public/GoldJournal_EA.mq5"),
    resolve(process.env.LAMBDA_TASK_ROOT || "", "client/public/GoldJournal_EA.mq5"),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // The source-relative candidate is unavailable after bundling; continue
      // to the explicitly included Netlify function artifact path.
    }
  }
  throw new Error("MT5 EA template is unavailable in this deployment.");
}

function firstForwardedValue(value: string | string[] | undefined) {
  const source = Array.isArray(value) ? value[0] : value;
  return source?.split(",")[0]?.trim() || "";
}

function validPublicHost(host: string) {
  return /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host) && !host.includes("..");
}

export function mt5EndpointForRequest(request: Request) {
  const host = firstForwardedValue(request.headers["x-forwarded-host"]) || request.get("host") || "";
  if (!validPublicHost(host)) return null;
  const forwardedProtocol = firstForwardedValue(request.headers["x-forwarded-proto"]);
  const protocol = forwardedProtocol === "https" || forwardedProtocol === "http"
    ? forwardedProtocol
    : request.protocol === "https" ? "https" : "http";
  return `${protocol}://${host}/api/mt5`;
}

export function renderMt5EaForRequest(request: Request) {
  const endpoint = mt5EndpointForRequest(request);
  return endpoint ? loadEaSource().replace(EA_ENDPOINT_TOKEN, endpoint) : null;
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
