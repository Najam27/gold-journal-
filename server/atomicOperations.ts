import { getSupabaseAdmin } from "./supabaseAdmin";

type SupabaseRpcError = { message: string; code?: string; details?: string; hint?: string };

function throwRpcError(operation: string, error: SupabaseRpcError) {
  const wrapped = new Error(`Supabase atomic operation ${operation} failed: ${error.message}`) as Error & { supabaseCode?: string; supabaseDetails?: string; supabaseHint?: string };
  wrapped.supabaseCode = error.code;
  wrapped.supabaseDetails = error.details;
  wrapped.supabaseHint = error.hint;
  throw wrapped;
}

export async function clearAccountJournalDataAtomic(userId: number, accountId: number, resetAt: Date) {
  const { data, error } = await getSupabaseAdmin().rpc("gj_clear_account_journal_data", {
    target_user_id: userId,
    target_account_id: accountId,
    target_reset_at: resetAt.toISOString(),
  });
  if (error) throwRpcError("clear account journal data", error);
  return data === true;
}

export async function removeAccountAtomic(userId: number, accountId: number) {
  const { data, error } = await getSupabaseAdmin().rpc("gj_remove_account", {
    target_user_id: userId,
    target_account_id: accountId,
  });
  if (error) throwRpcError("remove account", error);
  const replacement = Array.isArray(data) ? data[0]?.replacement_account_id : (data as { replacement_account_id?: number } | null)?.replacement_account_id;
  if (!Number.isInteger(replacement)) throw new Error("Supabase atomic account removal returned no replacement account.");
  return { success: true as const, replacementAccountId: replacement };
}

export async function recordGoalAlertsAtomic(userId: number, accountId: number, alerts: Array<{ goalId: number; type: string; message: string }>) {
  const { data, error } = await getSupabaseAdmin().rpc("gj_record_goal_alerts", {
    target_user_id: userId,
    target_account_id: accountId,
    alerts,
  });
  if (error) throwRpcError("record goal alerts", error);
  const recorded = Number(data ?? 0);
  if (!Number.isInteger(recorded) || recorded < 0 || recorded > alerts.length) throw new Error("Supabase atomic goal-alert batch returned an invalid count.");
  return recorded;
}

export async function syncMt5PositionAtomic(userId: number, accountId: number, position: Record<string, unknown>) {
  const { data, error } = await getSupabaseAdmin().rpc("gj_sync_mt5_position", {
    target_user_id: userId,
    target_account_id: accountId,
    position_payload: position,
  });
  if (error) throwRpcError("sync MT5 position", error);
  return data === true;
}

export async function syncMt5OpenBatchAtomic(userId: number, accountId: number, positions: Array<Record<string, unknown>>) {
  const { data, error } = await getSupabaseAdmin().rpc("gj_sync_mt5_open_batch", {
    target_user_id: userId,
    target_account_id: accountId,
    position_payloads: positions,
  });
  if (error) throwRpcError("sync MT5 open batch", error);
  const synchronized = Number(data ?? 0);
  if (!Number.isInteger(synchronized) || synchronized < 0 || synchronized > positions.length) {
    throw new Error("Supabase atomic MT5 open batch returned an invalid count.");
  }
  return synchronized;
}

export async function recordMt5EventFailureAtomic(connectionId: number, operation: "summary" | "open_batch" | "history_batch", code: string, message: string) {
  const { data, error } = await getSupabaseAdmin().rpc("gj_record_mt5_event_failure", {
    target_connection_id: connectionId,
    target_operation: operation,
    target_error_code: code,
    target_error_message: message,
  });
  if (error) throwRpcError("record MT5 event failure", error);
  return data === true;
}

export async function touchMt5ConnectionAtomic(connectionId: number) {
  const { data, error } = await getSupabaseAdmin().rpc("gj_touch_mt5_connection", {
    target_connection_id: connectionId,
  });
  if (error) throwRpcError("touch MT5 connection", error);
  if (data !== true) throw new Error("Supabase MT5 contact update did not affect the authenticated connection.");
}

export async function updateMt5AccountSummaryAtomic(
  connectionId: number,
  summary: {
    mt5Login: bigint;
    brokerServer: string;
    currency: string;
    balance: number;
    equity: number;
    margin: number;
    freeMargin: number;
    floatingPnl: number;
    riskSymbol?: string;
    riskTickSize?: number;
    riskTickValueLoss?: number;
    riskContractSize?: number;
    riskVolumeMin?: number;
    riskVolumeMax?: number;
    riskVolumeStep?: number;
  },
) {
  const { data, error } = await getSupabaseAdmin().rpc("gj_update_mt5_connection_summary", {
    target_connection_id: connectionId,
    summary_payload: {
      mt5Login: summary.mt5Login.toString(),
      brokerServer: summary.brokerServer,
      currency: summary.currency,
      balance: summary.balance,
      equity: summary.equity,
      margin: summary.margin,
      freeMargin: summary.freeMargin,
      floatingPnl: summary.floatingPnl,
      riskSymbol: summary.riskSymbol ?? null,
      riskTickSize: summary.riskTickSize ?? null,
      riskTickValueLoss: summary.riskTickValueLoss ?? null,
      riskContractSize: summary.riskContractSize ?? null,
      riskVolumeMin: summary.riskVolumeMin ?? null,
      riskVolumeMax: summary.riskVolumeMax ?? null,
      riskVolumeStep: summary.riskVolumeStep ?? null,
    },
  });
  if (error) throwRpcError("update MT5 account summary", error);
  if (data !== true) throw new Error("Supabase MT5 summary update did not affect the authenticated connection.");
}

export async function syncMt5HistoryBatchAtomic(userId: number, accountId: number, positions: Array<Record<string, unknown>>) {
  const { data, error } = await getSupabaseAdmin().rpc("gj_sync_mt5_history_batch", {
    target_user_id: userId,
    target_account_id: accountId,
    position_payloads: positions,
  });
  if (error) throwRpcError("sync MT5 history batch", error);
  const synchronized = Number(data ?? 0);
  if (!Number.isInteger(synchronized) || synchronized < 0 || synchronized > positions.length) {
    throw new Error("Supabase atomic MT5 history batch returned an invalid count.");
  }
  return synchronized;
}
