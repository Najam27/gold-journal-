import { describe, expect, it } from "vitest";

import { goldRouter } from "./goldRouter";

function formatRr(risk: number | null, reward: number | null) {
  if (risk === null || reward === null || risk <= 0) return "—";
  return `1 : ${(reward / risk).toFixed(2)}`;
}

function getPacketSession(hour: number) {
  if (hour >= 3 && hour < 5) return "Pre-Asian";
  if (hour < 8) return "Asian";
  if (hour < 10) return "Post-Asian";
  if (hour < 12) return "Pre-London";
  if (hour < 14) return "London";
  if (hour < 16) return "Post-London";
  if (hour < 17) return "Pre-NY";
  if (hour < 20) return "New York";
  return "Post-NY";
}

describe("Gold Journal trading primitives", () => {
  it("formats risk/reward in the required 1 : X format", () => {
    expect(formatRr(50, 200)).toBe("1 : 4.00");
    expect(formatRr(0, 200)).toBe("—");
  });

  it("classifies PKT sessions", () => {
    expect(getPacketSession(4)).toBe("Pre-Asian");
    expect(getPacketSession(12)).toBe("London");
    expect(getPacketSession(1)).toBe("Asian");
  });

  it("rejects an invalid trade payload before it can write cloud data", async () => {
    const caller = goldRouter.createCaller({ user: { id: 7 } } as any);
    await expect(caller.trades.create({ accountId: 0 } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects invalid server-pagination bounds before reading an account", async () => {
    const caller = goldRouter.createCaller({ user: { id: 7 } } as any);
    await expect(caller.trades.list({ accountId: 7, page: 0, pageSize: 12 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.trades.list({ accountId: 7, page: 1, pageSize: 51 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a future manual trade date before any account or database access", async () => {
    const caller = goldRouter.createCaller({ user: { id: 7 } } as any);
    await expect(caller.trades.create({ accountId: 7, tradeDate: Date.now() + 3 * 86_400_000, session: "London", direction: "BUY", result: "WIN", patienceScore: null, risk: null, reward: null, pnl: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Future trade dates are not allowed." });
  });
});
