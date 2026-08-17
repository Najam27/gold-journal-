import { describe, expect, it } from "vitest";
import { pktSession } from "./mt5Db";

describe("MT5 PKT session classification", () => {
  it("uses the trader-specified PKT session boundaries exactly", () => {
    const pkt = (time: string) => new Date(`2026-08-13T${time}+05:00`);

    expect(pktSession(pkt("02:59:00"))).toBe("Post-NY");
    expect(pktSession(pkt("03:00:00"))).toBe("Pre-Asian");
    expect(pktSession(pkt("04:59:00"))).toBe("Pre-Asian");
    expect(pktSession(pkt("05:00:00"))).toBe("Asian");
    expect(pktSession(pkt("07:59:00"))).toBe("Asian");
    expect(pktSession(pkt("08:00:00"))).toBe("Post-Asian");
    expect(pktSession(pkt("09:59:00"))).toBe("Post-Asian");
    expect(pktSession(pkt("10:00:00"))).toBe("Pre-London");
    expect(pktSession(pkt("11:59:00"))).toBe("Pre-London");
    expect(pktSession(pkt("12:00:00"))).toBe("London");
    expect(pktSession(pkt("13:59:00"))).toBe("London");
    expect(pktSession(pkt("14:00:00"))).toBe("Post-London");
    expect(pktSession(pkt("15:59:00"))).toBe("Post-London");
    expect(pktSession(pkt("16:00:00"))).toBe("Pre-NY");
    expect(pktSession(pkt("16:59:00"))).toBe("Pre-NY");
    expect(pktSession(pkt("17:00:00"))).toBe("New York");
    expect(pktSession(pkt("19:59:00"))).toBe("New York");
    expect(pktSession(pkt("20:00:00"))).toBe("Post-NY");
  });
});
