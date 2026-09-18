import { randomUUID } from "node:crypto";

/**
 * Diagnostics for the trade persistence path.
 *
 * A failed write used to surface as an anonymous 500 with no way to tell a
 * constraint violation from a Supabase outage. Every persistence failure now
 * emits one structured, greppable record — and the client gets a safe message
 * plus the same correlation id, so a user can report "reference X" and the
 * server log can be found immediately.
 *
 * What is recorded is deliberately narrow: identifiers, operation names, the
 * provider's own error code/details/hint, and a duration. Never credentials,
 * tokens, note/emotion text, or signed screenshot URLs.
 */

export type PersistenceStage =
  | "trade.create"
  | "trade.update"
  | "trade.delete"
  | "trade.list"
  | "trade.screenshot.upload"
  | "journal.get"
  | "cash.create";

export type PersistenceContext = {
  stage: PersistenceStage;
  userId?: number | null;
  accountId?: number | null;
  mutationId?: string | null;
  tradeId?: number | null;
};

type ProviderError = { message?: unknown; code?: unknown; details?: unknown; hint?: unknown; name?: unknown };

export function newCorrelationId() {
  return `gj-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** The safe, structured record. Exported so tests can assert on the shape. */
export function persistenceFailureRecord(context: PersistenceContext & { error: unknown; correlationId: string; durationMs?: number }) {
  const error = context.error;
  const provider = (error ?? {}) as ProviderError;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown persistence failure";
  return {
    level: "error",
    scope: "persistence",
    correlationId: context.correlationId,
    stage: context.stage,
    userId: context.userId ?? null,
    accountId: context.accountId ?? null,
    mutationId: context.mutationId ?? null,
    tradeId: context.tradeId ?? null,
    durationMs: context.durationMs ?? null,
    errorName: (error instanceof Error ? error.name : provider.name) ?? "Error",
    errorMessage: String(message).slice(0, 400),
    // Supabase surfaces its own classification here; without it a "new row
    // violates unique constraint" and a "connection reset" look identical.
    providerCode: provider.code == null ? null : String(provider.code).slice(0, 64),
    providerDetails: provider.details == null ? null : String(provider.details).slice(0, 400),
    providerHint: provider.hint == null ? null : String(provider.hint).slice(0, 200),
  };
}

export function logPersistenceFailure(context: PersistenceContext & { error: unknown; correlationId: string; durationMs?: number }) {
  try {
    console.error("[persistence]", JSON.stringify(persistenceFailureRecord(context)));
  } catch {
    // Logging must never be the reason a request fails.
  }
}

export function logPersistenceEvent(event: string, context: PersistenceContext & { detail?: Record<string, unknown> }) {
  try {
    const { stage, detail, ...rest } = context;
    console.info("[persistence]", JSON.stringify({ scope: "persistence", stage: event, ...rest, ...(detail ?? {}) }));
  } catch {
    // ignore
  }
}

/**
 * Runs one persistence operation with diagnostics attached.
 *
 * Provider failures are re-thrown as a TRPCError whose `cause` carries the
 * correlation id (the tRPC error formatter lifts it into `data.correlationId`),
 * so a lost write is always traceable from the browser to the server log.
 */
export async function withPersistenceDiagnostics<T>(context: PersistenceContext, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const correlationId = newCorrelationId();
  try {
    const result = await run();
    return result;
  } catch (error) {
    logPersistenceFailure({ ...context, error, correlationId, durationMs: Date.now() - startedAt });
    throw attachCorrelation(error, correlationId);
  }
}

/**
 * Marks an error as already-classified (a validation or authorization refusal
 * the user is meant to read) so the boundary does not re-log it as a backend
 * fault or replace its message.
 */
export function attachCorrelation(error: unknown, correlationId: string) {
  if (error && typeof error === "object") {
    try {
      Object.defineProperty(error, "correlationId", { value: correlationId, enumerable: false, configurable: true });
    } catch {
      // frozen error: the correlation id stays in the log only
    }
  }
  return error;
}

export function correlationIdOf(error: unknown): string | null {
  const value = (error as { correlationId?: unknown } | null | undefined)?.correlationId;
  return typeof value === "string" ? value : null;
}
