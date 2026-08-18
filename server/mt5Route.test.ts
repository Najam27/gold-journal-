import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMt5Ingest } from "./mt5Ingest";
import { mt5JsonBody } from "./mt5Http";

const mocks = vi.hoisted(() => ({
  getActive: vi.fn(),
  failure: vi.fn(),
}));

vi.mock("./mt5Db", () => ({
  getActiveMt5Connection: mocks.getActive,
  recordMt5HistoryFailure: mocks.failure,
  touchMt5Connection: vi.fn(),
  upsertMt5OpenPosition: vi.fn(),
  upsertMt5ClosedPosition: vi.fn(),
  updateMt5AccountSummary: vi.fn(),
  completeMt5HistorySync: vi.fn(),
  recordMt5HistoryAttempt: vi.fn(),
  recordMt5HistoryAccepted: vi.fn(),
}));

async function withServer<T>(run: (baseUrl: string) => Promise<T>) {
  const app = express();
  app.use(mt5JsonBody);
  registerMt5Ingest(app);
  app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path === "/api/mt5" && error instanceof SyntaxError && "body" in error) return res.status(400).json({ ok: false, code: "INVALID_JSON" });
    next(error);
  });
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a port.");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe("MT5 HTTP route safety", () => {
  beforeEach(() => {
    mocks.getActive.mockReset().mockResolvedValue({ id: 44, userId: 77, accountId: 12, active: true });
    mocks.failure.mockReset();
  });

  it("returns a bounded invalid-json response for malformed request bodies", async () => {
    const response = await withServer(baseUrl => fetch(`${baseUrl}/api/mt5`, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"event\":\"ping\"," }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, code: "INVALID_JSON" });
    expect(mocks.getActive).not.toHaveBeenCalled();
  });

  it("accepts a valid MQL5 JSON body with a trailing NUL terminator", async () => {
    const payload = JSON.stringify({ event: "ping", api_key: "mt5_live_key_nul_padding_xxxxxxxxxxxxx" });
    const response = await withServer(baseUrl => fetch(`${baseUrl}/api/mt5`, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat([Buffer.from(payload), Buffer.from([0])] ) }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, event: "ping" });
  });
});
