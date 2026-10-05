import React from "react";
import type { TradeEnvironment } from "@shared/tradeEnvironment";

type Props = {
  value: TradeEnvironment;
  onChange: (environment: TradeEnvironment) => void;
  /** Renders tighter for the mobile row under the trade log. */
  compact?: boolean;
};

/**
 * The top-level LIVE | TESTING switch. Live and Testing are the same Trade
 * Log; the switch only changes which environment the app reads and writes.
 */
export default function TradeEnvironmentSwitch({ value, onChange, compact = false }: Props) {
  return (
    <div
      className={`trade-env-switch${compact ? " trade-env-switch--compact" : ""}`}
      role="group"
      aria-label="Journal mode"
      data-env={value}
    >
      {(["LIVE", "TESTING"] as const).map((env) => (
        <button
          key={env}
          type="button"
          className={value === env ? "active" : ""}
          aria-pressed={value === env}
          onClick={() => {
            if (env !== value) onChange(env);
          }}
        >
          {env === "LIVE" ? "Live" : "Testing"}
        </button>
      ))}
    </div>
  );
}
