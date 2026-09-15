/**
 * Request performance instrumentation for the composite journal reads.
 *
 * The Trade Log timeout was caused by expensive work (MT5 reconciliation and a
 * nine-query composite read) being performed inside a single request with no
 * visibility into which stage was slow. Every stage now reports its own
 * duration, so the next regression is visible in the server logs instead of
 * surfacing as an opaque client timeout.
 */

/** Above this, a stage is worth investigating. */
export const PERF_INVESTIGATE_MS = 1_000;
/** Above this, a stage is a performance problem, not a slow query. */
export const PERF_PROBLEM_MS = 3_000;

export type PerfStage = { stage: string; durationMs: number };
export type PerfTrace = {
  readonly stages: PerfStage[];
  stage: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  measure: <T>(name: string, run: () => T) => T;
  done: () => { totalMs: number; stages: PerfStage[] };
};

function describeContext(context: Record<string, unknown>) {
  const entries = Object.entries(context).filter(([, value]) => value !== undefined && value !== null);
  return entries.length ? ` ${entries.map(([key, value]) => `${key}=${String(value)}`).join(" ")}` : "";
}

/**
 * Creates a trace that logs `[PERF] <label> <stage> duration=<ms>ms` for every
 * stage plus a final total. Warnings are emitted for stages above the
 * investigate/problem thresholds so a slow stage is never silently accepted.
 */
export function createPerfTrace(
  label: string,
  context: Record<string, unknown> = {},
  options: { clock?: () => number; log?: (line: string) => void; warn?: (line: string) => void } = {}
): PerfTrace {
  const clock = options.clock ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const startedAt = clock();
  const contextText = describeContext(context);
  const stages: PerfStage[] = [];
  log(`[PERF] ${label} start${contextText}`);

  const record = (stage: string, durationMs: number) => {
    stages.push({ stage, durationMs });
    log(`[PERF] ${label} ${stage} duration=${durationMs}ms${contextText}`);
    if (durationMs >= PERF_PROBLEM_MS) warn(`[PERF] ${label} ${stage} is a performance problem at ${durationMs}ms (>= ${PERF_PROBLEM_MS}ms)${contextText}`);
    else if (durationMs >= PERF_INVESTIGATE_MS) warn(`[PERF] ${label} ${stage} needs investigation at ${durationMs}ms (>= ${PERF_INVESTIGATE_MS}ms)${contextText}`);
  };

  return {
    stages,
    measure(name, run) {
      const at = clock();
      try {
        return run();
      } finally {
        record(name, clock() - at);
      }
    },
    async stage(name, run) {
      const at = clock();
      try {
        return await run();
      } finally {
        record(name, clock() - at);
      }
    },
    done() {
      const totalMs = clock() - startedAt;
      log(`[PERF] ${label} total duration=${totalMs}ms${contextText}`);
      if (totalMs >= PERF_PROBLEM_MS) warn(`[PERF] ${label} total is a performance problem at ${totalMs}ms (>= ${PERF_PROBLEM_MS}ms)${contextText}`);
      else if (totalMs >= PERF_INVESTIGATE_MS) warn(`[PERF] ${label} total needs investigation at ${totalMs}ms (>= ${PERF_INVESTIGATE_MS}ms)${contextText}`);
      return { totalMs, stages: [...stages] };
    },
  };
}
