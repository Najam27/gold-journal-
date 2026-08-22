import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AnalysisFilters } from "@shared/analysisEngine";
import type { RiskCalculation } from "@shared/riskCalculator";
import { getAccountAnalysis } from "./analysisDb";
import { analyzeWithOpenRouter } from "./analysisAi";
import { persistAiOutcome } from "./aiReportDb";
import { getOwnedAccount } from "./goldDb";
import { coachRiskWithOpenRouter } from "./riskCoachAi";
import { getSupabaseAdmin } from "./supabaseAdmin";

export type AiJobKind = "ANALYSIS" | "RISK_COACH";
export type AiJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
type AiJobRow = { id: string; userId: number; accountId: number; kind: AiJobKind; status: AiJobStatus; dispatchHash: string; payload: Record<string, unknown>; result: Record<string, unknown> | null; errorMessage: string | null; createdAt: string; updatedAt: string; completedAt: string | null };
type Dispatch = { id: string; token: string };

const tokenHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const safeFailure = "AI processing did not complete. Please retry from the journal.";

async function insertJob(userId: number, accountId: number, kind: AiJobKind, payload: Record<string, unknown>): Promise<Dispatch> {
  await getOwnedAccount(userId, accountId);
  const id = randomUUID(); const token = randomBytes(32).toString("base64url");
  const { error } = await getSupabaseAdmin().from("gj_ai_jobs").insert({ id, userId, accountId, kind, status: "QUEUED", dispatchHash: tokenHash(token), payload });
  if (error) throw new Error("Unable to queue AI processing. Please retry.");
  return { id, token };
}

export async function queueAnalysisJob(userId: number, accountId: number, filters: AnalysisFilters) { return insertJob(userId, accountId, "ANALYSIS", { filters }); }
export async function queueRiskCoachJob(userId: number, accountId: number, calculation: RiskCalculation) { return insertJob(userId, accountId, "RISK_COACH", { calculation }); }

function workerOrigin() {
  const configured = process.env.AI_JOB_WORKER_BASE_URL?.trim() || process.env.URL?.trim() || process.env.DEPLOY_PRIME_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return "";
}

export async function dispatchAiJob(dispatch: Dispatch) {
  const origin = workerOrigin();
  if (!origin) throw new Error("AI background processing is unavailable on this deployment.");
  const response = await fetch(`${origin}/.netlify/functions/ai-job-worker`, { method: "POST", headers: { "Content-Type": "application/json", "X-Gold-Journal-AI-Dispatch": dispatch.token }, body: JSON.stringify({ jobId: dispatch.id }), signal: AbortSignal.timeout(10_000) });
  if (response.status !== 202) throw new Error("AI background processing could not be started. Please retry.");
}
export async function failQueuedAiJob(userId: number, jobId: string) {
  await getSupabaseAdmin().from("gj_ai_jobs").update({ status: "FAILED", errorMessage: "AI background processing could not be started. Please retry.", completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).eq("id", jobId).eq("userId", userId).eq("status", "QUEUED");
}

async function loadOwnedJob(userId: number, jobId: string) {
  const { data, error } = await getSupabaseAdmin().from("gj_ai_jobs").select("id,userId,accountId,kind,status,result,errorMessage,createdAt,updatedAt,completedAt").eq("id", jobId).eq("userId", userId).maybeSingle();
  if (error) throw new Error("Unable to load AI processing status.");
  return data as Omit<AiJobRow, "dispatchHash" | "payload"> | null;
}

export async function getAiJobStatus(userId: number, jobId: string) {
  const job = await loadOwnedJob(userId, jobId);
  if (!job) throw new Error("That AI processing request is unavailable.");
  return { id: job.id, kind: job.kind, status: job.status, result: job.result, message: job.status === "FAILED" ? job.errorMessage || safeFailure : null, completedAt: job.completedAt };
}

async function claimJob(jobId: string, token: string) {
  const { data, error } = await getSupabaseAdmin().from("gj_ai_jobs").update({ status: "RUNNING", updatedAt: new Date().toISOString() }).eq("id", jobId).eq("dispatchHash", tokenHash(token)).eq("status", "QUEUED").select("id,userId,accountId,kind,status,dispatchHash,payload,result,errorMessage,createdAt,updatedAt,completedAt").maybeSingle();
  if (error) throw new Error("Unable to claim AI job.");
  return data as AiJobRow | null;
}

async function completeJob(job: AiJobRow, result: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin().from("gj_ai_jobs").update({ status: "COMPLETED", result, errorMessage: null, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).eq("id", job.id).eq("status", "RUNNING");
  if (error) throw new Error("Unable to save AI job result.");
}
async function failJob(jobId: string) { await getSupabaseAdmin().from("gj_ai_jobs").update({ status: "FAILED", errorMessage: safeFailure, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).eq("id", jobId).eq("status", "RUNNING"); }

export async function runAiJob(jobId: string, token: string) {
  const job = await claimJob(jobId, token);
  if (!job) return { claimed: false };
  try {
    if (job.kind === "ANALYSIS") {
      const filters = (job.payload.filters ?? {}) as AnalysisFilters;
      const deterministic = await getAccountAnalysis(job.userId, job.accountId, filters);
      const ai = await analyzeWithOpenRouter(job.userId, job.accountId, deterministic);
      if (ai.available && ai.report) {
        try { ai.persistence = await persistAiOutcome(job.userId, job.accountId, deterministic, ai); }
        catch (error) { console.warn("[ai-job] analysis persistence degraded", error instanceof Error ? error.message : "unknown"); ai.persistence = { persisted: false, reportId: null, dataFingerprint: "" }; }
      }
      await completeJob(job, { ai });
    } else {
      const calculation = job.payload.calculation as RiskCalculation;
      await completeJob(job, { coach: await coachRiskWithOpenRouter(job.userId, calculation) });
    }
    return { claimed: true };
  } catch (error) {
    console.warn("[ai-job] processing failed", JSON.stringify({ jobId, kind: job.kind, reason: error instanceof Error ? error.message : "unknown" }));
    await failJob(job.id);
    return { claimed: true, failed: true };
  }
}

export const aiJobTestHooks = { tokenHash, workerOrigin };
