import { getSupabaseAdmin } from "./supabaseAdmin";

function throwRpcError(operation: string, error: { message: string }) {
  throw new Error(`Supabase atomic operation ${operation} failed: ${error.message}`);
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
    position,
  });
  if (error) throwRpcError("sync MT5 position", error);
  return data === true;
}
