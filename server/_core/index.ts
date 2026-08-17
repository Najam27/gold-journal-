import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { registerMt5Ingest } from "../mt5Ingest";
import { getActiveMt5Connection, recordMt5HistoryFailure } from "../mt5Db";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { validateRuntimeConfiguration } from "./env";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  validateRuntimeConfiguration();
  const app = express();
  const server = createServer(app);
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (process.env.NODE_ENV === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });
  app.use("/api/mt5", express.json({ limit: "256kb" }));
  // Screenshot uploads use authenticated tRPC and are validated again by the
  // procedure to a decoded 5 MB image. Other application JSON stays small.
  app.use("/api/trpc", express.json({ limit: "10mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));
  registerMt5Ingest(app);
  app.use(async (error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if ((error as { type?: string })?.type === "entity.too.large") {
      res.status(413).json({ ok: false, code: "PAYLOAD_TOO_LARGE" });
      return;
    }
    if (req.path === "/api/mt5" && error instanceof SyntaxError && "body" in error) {
      const detail = "Malformed JSON request body.";
      console.warn("[MT5] malformed JSON payload");
      const raw = typeof (error as { body?: unknown }).body === "string" ? (error as { body: string }).body : "";
      const apiKey = raw.match(/"api_key"\s*:\s*"([^"\\]{24,96})"/)?.[1];
      if (apiKey) {
        try {
          const connection = await getActiveMt5Connection(apiKey);
          if (connection) await recordMt5HistoryFailure(connection.id, `Malformed JSON — ${detail}`);
        } catch {
          // Preserve an actionable parser response even if diagnostics cannot persist.
        }
      }
      res.status(400).json({ ok: false, code: "INVALID_JSON", details: [detail] });
      return;
    }
    next(error);
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(error => {
  console.error("[Server] Startup failed.");
  if (process.env.NODE_ENV !== "production") console.error(error);
  process.exitCode = 1;
});
