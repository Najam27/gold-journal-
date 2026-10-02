import { cn } from "@/lib/utils";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * "page" (default) takes over the whole screen and reloads — the last
   * resort at the app root. "section" keeps the rest of the app alive and
   * retries in place, so one broken view can't blank the whole journal.
   */
  variant?: "page" | "section";
  /** Label for section fallbacks ("This view"). */
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // No external error reporter is wired up; the console is the record.
    console.error("[gold-journal] render error", error, info.componentStack);
  }

  private reset = () => this.setState({ hasError: false, error: null });

  render() {
    if (this.state.hasError) {
      // Raw stacks help nobody in production and leak internals; developers
      // still get them (and the console keeps the full error either way).
      const detail = import.meta.env.DEV
        ? this.state.error?.stack
        : this.state.error?.message;
      if (this.props.variant === "section") {
        return (
          <div className="gj-section-error" role="alert">
            <AlertTriangle size={22} className="text-destructive flex-shrink-0" />
            <div>
              <h3>{this.props.label ?? "This view"} hit an unexpected error.</h3>
              <p>Your journal data is untouched. Try again, or reload if it keeps happening.</p>
              {detail && <pre className="gj-section-error-detail">{detail}</pre>}
              <div className="gj-section-error-actions">
                <button onClick={this.reset} className={cn("flex items-center gap-2 px-4 py-2 rounded-lg", "bg-primary text-primary-foreground", "hover:opacity-90 cursor-pointer")}>
                  <RotateCcw size={16} />
                  Try again
                </button>
                <button onClick={() => window.location.reload()} className={cn("flex items-center gap-2 px-4 py-2 rounded-lg", "bg-muted text-muted-foreground", "hover:opacity-90 cursor-pointer")}>
                  Reload page
                </button>
              </div>
            </div>
          </div>
        );
      }
      return (
        <div className="flex items-center justify-center min-h-screen p-8 bg-background">
          <div className="flex flex-col items-center w-full max-w-2xl p-8">
            <AlertTriangle
              size={48}
              className="text-destructive mb-6 flex-shrink-0"
            />

            <h2 className="text-xl mb-4">An unexpected error occurred.</h2>

            <div className="p-4 w-full rounded bg-muted overflow-auto mb-6">
              <pre className="text-sm text-muted-foreground whitespace-break-spaces">
                {detail}
              </pre>
            </div>

            <button
              onClick={() => window.location.reload()}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg",
                "bg-primary text-primary-foreground",
                "hover:opacity-90 cursor-pointer"
              )}
            >
              <RotateCcw size={16} />
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
