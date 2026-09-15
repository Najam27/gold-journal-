import { RefreshCcw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { classifyApiError } from "@/lib/apiErrors";

/**
 * Categorized failure surface.
 *
 * The previous version showed one generic heading and whatever message the
 * failing layer produced, so a slow database read, an expired session, a missing
 * account, and a dead network all looked identical. Every failure now shows its
 * category, what it means, what to do, and the correlation id that matches the
 * single structured `[API]` log line for that request.
 */
export function JournalQueryError({
  error,
  onRetry,
  title,
}: {
  error: unknown;
  onRetry: () => void;
  title?: string;
}) {
  const facts = classifyApiError(error);
  return (
    <section className="panel query-error" role="alert">
      <ShieldAlert size={25} />
      <div>
        <span className="eyebrow">SYNC NEEDS ATTENTION · {facts.category}</span>
        <h2>{title ?? facts.title}</h2>
        <p>{facts.detail}</p>
        {facts.guidance && <p className="query-error-guidance">{facts.guidance}</p>}
        {facts.correlationId && (
          <p className="query-error-correlation">Reference: {facts.correlationId}</p>
        )}
        <Button onClick={onRetry}>
          <RefreshCcw size={15} /> {facts.retryable ? "Try again" : "Reload and sign in again"}
        </Button>
      </div>
    </section>
  );
}

/**
 * Account-switch progress.
 *
 * A switch is a transaction, not a reload: it shows which account it is moving
 * to and which read is loading first, instead of the generic full-page loader
 * that made a switch look like nothing had happened.
 */
export function SwitchingAccount({ name }: { name: string }) {
  return (
    <section className="panel switching-account" role="status" aria-live="polite">
      <RefreshCcw size={24} />
      <div>
        <span className="eyebrow">SWITCHING ACCOUNT</span>
        <h2>Switching to {name}…</h2>
        <p>
          Loading this account's Trade Log first. MT5 Live, goals, and analysis
          load immediately afterwards, so a switch never fires every view at once.
        </p>
      </div>
    </section>
  );
}
