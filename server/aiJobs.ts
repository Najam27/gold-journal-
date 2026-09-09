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
// Background workers claim a job immediately, so any job still QUEUED long
// after dispatch is a worker that never started (missing/misconfigured
// background-function environment or a host that discarded the request).
const QUEUED_STALE_AFTER_MS = 2 * 60_000;
// A RUNNING job that outlives the maximum provider budget plus processing
// margin is stuck (worker froze or the host terminated it mid-flight).
const RUNNING_STALE_AFTER_MS = 16 * 60_000;

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

function allowInlineWorkerFallback() {
  const explicit = process.env.AI_JOB_INLINE_FALLBACK?.trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  // Netlify does not set NODE_ENV unless it is configured explicitly, and its
  // functions freeze after the response, so the old implicit "not production"
  // fallback silently left every job QUEUED/RUNNING forever on a missing
  // worker base URL. Inline dispatch is now opt-in (long-running process
  // servers such as `pnpm dev` set AI_JOB_INLINE_FALLBACK=true) and never
  // auto-enabled by an unset NODE_ENV. An explicit false wins everywhere,
  // and an explicit true is honored on any runtime so operators can opt in.
  if (process.env.AI_JOB_INLINE_FALLBACK === "false") return false;
  if (process.env.AI_JOB_INLINE_FALLBACK === "true") return true;
  return process.env.NODE_ENV === "development";
}

function dispatchInlineAiJob(dispatch: Dispatch) {
  setTimeout(() => {
    void runAiJob(dispatch.id, dispatch.token).catch(error => {
      console.warn("[ai-job] inline dispatch failed", JSON.stringify({ jobId: dispatch.id, reason: error instanceof Error ? error.message : "unknown" }));
    });
  }, 0);
}

export async function dispatchAiJob(dispatch: Dispatch) {
  const origin = workerOrigin();
  if (!origin) {
    if (allowInlineWorkerFallback()) {
      dispatchInlineAiJob(dispatch);
      return;
    }
    throw new Error("AI background processing is unavailable on this deployment.");
  }
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
  if (job.status === "QUEUED") {
    const created = Date.parse(job.createdAt ?? "");
    const queuedAgeMs = Number.isFinite(created) ? Date.now() - created : 0;
    if (queuedAgeMs > QUEUED_STALE_AFTER_MS) {
      await expireQueuedJob(userId, jobId, "AI processing did not start on this deployment. Check the background-function configuration, then retry.");
      job.status = "FAILED"; job.errorMessage = "AI processing did not start on this deployment. Check the background-function configuration, then retry.";
    }
  } else if (job.status === "RUNNING") {
    const updated = Date.parse(job.updatedAt ?? "");
    const runningAgeMs = Number.isFinite(updated) ? Date.now() - updated : 0;
    if (runningAgeMs > RUNNING_STALE_AFTER_MS) {
      await expireRunningJob(jobId, "AI processing is taking too long and has been stopped. Please retry from the journal.");
      job.status = "FAILED"; job.errorMessage = "AI processing is taking too long and has been stopped. Please retry from the journal.";
    }
  }
  return { id: job.id, kind: job.kind, status: job.status, result: job.result, message: job.status === "FAILED" ? job.errorMessage || safeFailure : null, completedAt: job.completedAt };
}

async function expireQueuedJob(userId: number, jobId: string, message: string) {
  await getSupabaseAdmin().from("gj_ai_jobs").update({ status: "FAILED", errorMessage: message, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).eq("id", jobId).eq("userId", userId).eq("status", "QUEUED");
}
async function expireRunningJob(jobId: string, message: string) {
  await getSupabaseAdmin().from("gj_ai_jobs").update({ status: "FAILED", errorMessage: message, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }).eq("id", jobId).eq("status", "RUNNING");
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

export const aiJobTestHooks = { tokenHash, workerOrigin, allowInlineWorkerFallback };
