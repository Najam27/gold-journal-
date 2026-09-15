import { describe, expect, it, vi } from "vitest";
import { createPerfTrace, PERF_INVESTIGATE_MS, PERF_PROBLEM_MS } from "./perf";

function createClock(step = 0) {
  let now = 0;
  return { advance: (ms: number) => { now += ms; }, clock: () => { now += step; return now; } };
}

describe("createPerfTrace", () => {
  it("logs start, every stage, and the total with the request context", async () => {
    const { clock, advance } = createClock();
    const log = vi.fn();
    const warn = vi.fn();
    const trace = createPerfTrace("journal.get", { userId: 7, accountId: 12 }, { clock, log, warn });

    await trace.stage("trades", async () => { advance(120); return "rows"; });
    trace.measure("profile", () => { advance(30); return "profile"; });
    trace.done();

    const lines = log.mock.calls.map(call => call[0]);
    expect(lines[0]).toBe("[PERF] journal.get start userId=7 accountId=12");
    expect(lines).toContain("[PERF] journal.get trades duration=120ms userId=7 accountId=12");
    expect(lines).toContain("[PERF] journal.get profile duration=30ms userId=7 accountId=12");
    expect(lines.at(-1)).toBe("[PERF] journal.get total duration=150ms userId=7 accountId=12");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once a stage crosses the investigate threshold and again at the problem threshold", async () => {
    const { clock, advance } = createClock();
    const log = vi.fn();
    const warn = vi.fn();
    const trace = createPerfTrace("journal.get", {}, { clock, log, warn });

    await trace.stage("goal trades", async () => { advance(PERF_INVESTIGATE_MS); });
    await trace.stage("rpc cash net", async () => { advance(PERF_PROBLEM_MS); });

    expect(warn.mock.calls.map(call => call[0])).toEqual([
      expect.stringContaining(`needs investigation at ${PERF_INVESTIGATE_MS}ms`),
      expect.stringContaining(`performance problem at ${PERF_PROBLEM_MS}ms`),
    ]);
    expect(trace.stages).toEqual([
      { stage: "goal trades", durationMs: PERF_INVESTIGATE_MS },
      { stage: "rpc cash net", durationMs: PERF_PROBLEM_MS },
    ]);
  });

  it("records a failed stage's duration and rethrows its error", async () => {
    const { clock, advance } = createClock();
    const log = vi.fn();
    const trace = createPerfTrace("journal.get", {}, { clock, log, warn: vi.fn() });

    await expect(
      trace.stage("cash", async () => {
        advance(45);
        throw new Error("Supabase account balance aggregate is unavailable");
      })
    ).rejects.toThrow("unavailable");
    expect(log.mock.calls.map(call => call[0])).toContain("[PERF] journal.get cash duration=45ms");
  });
});
