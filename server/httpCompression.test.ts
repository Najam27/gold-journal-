import express from "express";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { httpCompression } from "./httpCompression";

describe("HTTP response compression", () => {
  it("compresses sufficiently large JSON when the client accepts gzip", async () => {
    const app = express();
    app.use(httpCompression);
    const payload = { text: "gold-journal-response-".repeat(2_000) };
    app.get("/large", (_req, res) => res.json(payload));
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      const response = await fetch(`http://127.0.0.1:${address.port}/large`, { headers: { "accept-encoding": "gzip" } });
      expect(response.headers.get("content-encoding")).toBe("gzip");
      expect(await response.json()).toEqual(payload);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
