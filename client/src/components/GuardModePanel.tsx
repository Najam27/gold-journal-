import React, { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import type { GuardConfig } from "@/lib/guardMode";

const EMPTY: GuardConfig = {
  enabled: false,
  accountSize: null,
  dailyLossLimit: null,
  maxDrawdownLimit: null,
  maxTradesPerDay: null,
};

/**
 * Funded-account guard settings. Stored per account as `guardConfig` JSONB.
 * This is a journal-side tripwire, not broker enforcement: it warns you (and
 * can block journal actions) before you breach a funded account's rules —
 * daily loss, max drawdown, max trades per day.
 */
export function GuardModePanel({ accountId, guardConfig }: { accountId: number; guardConfig: GuardConfig | null | undefined }) {
  const [form, setForm] = useState<GuardConfig>(EMPTY);
  const utils = trpc.useUtils();
  const setGuardConfig = trpc.accounts.setGuardConfig.useMutation();

  useEffect(() => {
    setForm({
      enabled: guardConfig?.enabled === true,
      accountSize: guardConfig?.accountSize ?? null,
      dailyLossLimit: guardConfig?.dailyLossLimit ?? null,
      maxDrawdownLimit: guardConfig?.maxDrawdownLimit ?? null,
      maxTradesPerDay: guardConfig?.maxTradesPerDay ?? null,
    });
  }, [accountId, guardConfig]);

  const num = (value: string): number | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  const save = async () => {
    try {
      await setGuardConfig.mutateAsync({ accountId, guardConfig: form });
      await utils.accounts.list.invalidate();
      toast.success(form.enabled ? "Guard mode armed." : "Guard settings saved.");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Could not save guard settings.");
    }
  };

  const field = (label: string, value: number | null, hint: string, onChange: (value: number | null) => void) => (
    <label className="guard-field">
      <span>{label}</span>
      <Input
        type="text"
        inputMode="decimal"
        placeholder="—"
        value={value == null ? "" : String(value)}
        onChange={event => onChange(num(event.target.value))}
      />
      <small>{hint}</small>
    </label>
  );

  return (
    <section className="panel guard-panel">
      <header>
        <span><ShieldCheck size={15} /> Funded-account guard</span>
        <label className="guard-toggle">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={event => setForm({ ...form, enabled: event.target.checked })}
          />
          <i />
          {form.enabled ? "Armed" : "Off"}
        </label>
      </header>
      <p className="guard-copy">
        Tripwires for funded / prop accounts: the journal watches daily loss,
        total drawdown, and trades per day, and warns you at 80% — before the
        broker's rules stop you. Journal-side only: it can't block your broker.
      </p>
      <div className="guard-grid">
        {field("Account size $", form.accountSize, "Equity baseline for drawdown math.", value => setForm({ ...form, accountSize: value }))}
        {field("Daily loss limit $", form.dailyLossLimit, "Max realized loss per PKT day.", value => setForm({ ...form, dailyLossLimit: value }))}
        {field("Max drawdown $", form.maxDrawdownLimit, "Max fall from peak equity.", value => setForm({ ...form, maxDrawdownLimit: value }))}
        {field("Max trades / day", form.maxTradesPerDay, "Overtrading circuit-breaker.", value => setForm({ ...form, maxTradesPerDay: value }))}
      </div>
      <div className="guard-actions">
        <Button onClick={save} disabled={setGuardConfig.isPending}>
          {setGuardConfig.isPending ? "Saving…" : "Save guard"}
        </Button>
      </div>
    </section>
  );
}
