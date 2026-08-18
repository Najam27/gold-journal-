import express from "express";
import serverless from "serverless-http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../../server/routers";
import { createContext } from "../../server/_core/context";
import { registerMt5Ingest } from "../../server/mt5Ingest";
import { getActiveMt5Connection, recordMt5HistoryFailure } from "../../server/mt5Db";
import { validateRuntimeConfiguration } from "../../server/_core/env";
import { httpCompression } from "../../server/httpCompression";

validateRuntimeConfiguration();

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});
app.use(httpCompression);
app.use("/api/mt5", express.json({ limit: "256kb" }));
app.use("/api/trpc", express.json({ limit: "10mb" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));
registerMt5Ingest(app, ["/api/mt5", "/mt5"]);
app.use(async (error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if ((error as { type?: string })?.type === "entity.too.large") return res.status(413).json({ ok: false, code: "PAYLOAD_TOO_LARGE" });
  if ((req.path === "/api/mt5" || req.path === "/mt5") && error instanceof SyntaxError && "body" in error) {
    const raw = typeof (error as { body?: unknown }).body === "string" ? (error as { body: string }).body : "";
    const apiKey = raw.match(/"api_key"\s*:\s*"([^"\\]{24,96})"/)?.[1];
    if (apiKey) { try { const connection = await getActiveMt5Connection(apiKey); if (connection) await recordMt5HistoryFailure(connection.id, "Malformed JSON request body."); } catch { /* return the parser response */ } }
    return res.status(400).json({ ok: false, code: "INVALID_JSON", details: ["Malformed JSON request body."] });
  }
  next(error);
});
app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

export const handler = serverless(app);
