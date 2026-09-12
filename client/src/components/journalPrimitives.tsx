import React from "react";

/** Labelled form field used across the journal dialogs and risk panels. */
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Compact metric card used by the MT5 and risk surfaces. */
export function RiskMetric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <article className={`mt5-account-metric ${tone}`}>
      <span>{label}</span>
      <strong className="data-text">{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
