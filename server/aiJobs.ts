import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { AnalysisFilters } from "@shared/analysisEngine";
import type { RiskCalculation } from "@shared/riskCalculator";
import { getAccountAnalysis } from "./analysisDb";
import { analyzeWithOpenRouter } from "./analysisAi";
import { persistAiOutcome } from "./aiReportDb";
import { getOwnedAccount } from "./goldDb";
import { coachRiskWithOpenRouter } from "./riskCoachAi";
import { getSupabaseAdmin } from "./supabaseAdmin";

/** Route on the platform API entry that starts a durable AI job, mirrored by
 * the Cloudflare Worker entry (`/api/ai-job-dispatch`) and the local Express
 * server. */
export const AI_JOB_DISPATCH_PATH = "/api/ai-job-dispatch";

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

function dispatchInlineAiJob(dispatch: Dispatch) {
  setTimeout(() => {
    void runAiJob(dispatch.id, dispatch.token).catch(error => {
      console.warn("[ai-job] inline dispatch failed", JSON.stringify({ jobId: dispatch.id, reason: error instanceof Error ? error.message : "unknown" }));
    });
  }, 0);
}

function workerOrigin() {
  // AI_JOB_WORKER_BASE_URL is the canonical deployment origin (Cloudflare
  // custom domain). URL/DEPLOY_PRIME_URL were Netlify build-time injections
  // and are kept only for self-hosted Node servers that set them.
  const configured = process.env.AI_JOB_WORKER_BASE_URL?.trim() || process.env.URL?.trim() || process.env.DEPLOY_PRIME_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return "";
}

export function allowInlineWorkerFallback() {
  const explicit = process.env.AI_JOB_INLINE_FALLBACK?.trim().toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  // Only long-running Node processes enable inline processing implicitly
  // (NODE_ENV=development via `pnpm dev`). Serverless sandboxes never set
  // NODE_ENV=development, so an unset fallback stays disabled everywhere else.
  return process.env.NODE_ENV === "development";
}

/**
 * Starts durable AI work.
 *
 * Cloudflare Workers: dispatchAiJob posts to `/api/ai-job-dispatch` on this
 * deployment; the Worker entry executes the job in that invocation and
 * answers 202 when it completes. The dispatch connection stays open for up to
 * ~100s of provider I/O (the browser AI budget is 120s), and the atomic
 * QUEUED->RUNNING claim means a retry can never double-process a job. Jobs
 * that outlive every budget stay RUNNING until the status lease marks them
 * FAILED after sixteen minutes, so the UI always reaches a terminal state.
 * Node servers: `pnpm dev` (NODE_ENV=development) and any operator setting
 * AI_JOB_INLINE_FALLBACK=true run the job on an in-process timer instead,
 * which supports the full provider timeout on any long-running process.
 */
export async function dispatchAiJob(dispatch: Dispatch) {
  const origin = workerOrigin();
  if (!origin) {
    if (allowInlineWorkerFallback()) {
      dispatchInlineAiJob(dispatch);
      return;
    }
    throw new Error("AI background processing is unavailable on this deployment.");
  }
  const response = await fetch(`${origin}${AI_JOB_DISPATCH_PATH}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Gold-Journal-AI-Dispatch": dispatch.token }, body: JSON.stringify({ jobId: dispatch.id }), signal: AbortSignal.timeout(100_000) });
  if (response.status !== 202) throw new Error("AI background processing could not be started. Please retry.");
}

export type AiJobDispatchParse = { ok: true; jobId: string; token: string } | { ok: false; status: number; message: string };

/**
 * Shared validation for the durable-job dispatch endpoint so the Cloudflare
 * Worker and the local Express server accept exactly the same requests.
 */
export function parseAiJobDispatchRequest(method: string, tokenHeader: string | null | undefined, body: string | Record<string, unknown> | null): AiJobDispatchParse {
  if (method !== "POST") return { ok: false, status: 405, message: "Method not allowed" };
  let jobId = "";
  if (typeof body === "string") {
    if (body.trim()) {
      try {
        const parsed = JSON.parse(body) as { jobId?: unknown };
        if (typeof parsed?.jobId === "string") jobId = parsed.jobId;
      } catch {
        return { ok: false, status: 400, message: "Invalid background request" };
      }
    }
  } else if (body && typeof (body as { jobId?: unknown }).jobId === "string") {
    jobId = (body as { jobId: string }).jobId;
  }
  const token = (tokenHeader ?? "").trim();
  if (!token || !/^[A-Za-z0-9_-]{36,64}$/.test(token) || !/^[0-9a-f-]{36}$/i.test(jobId)) return { ok: false, status: 400, message: "Invalid background request" };
  return { ok: true, jobId, token };
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

/**
 * Express twin of the Worker's /api/ai-job-dispatch route, for standalone Node
 * servers that dispatch durable AI work to their own origin. It acknowledges
 * with 202 and runs the claimed job on an in-process timer.
 */
export function registerAiJobDispatch(app: Express, path = AI_JOB_DISPATCH_PATH) {
  app.post(path, (req: Request, res: Response) => {
    const tokenHeader = req.headers["x-gold-journal-ai-dispatch"];
    const parsed = parseAiJobDispatchRequest(req.method, typeof tokenHeader === "string" ? tokenHeader : null, (req.body ?? null) as Record<string, unknown> | null);
    if (!parsed.ok) {
      res.status(parsed.status).json({ ok: false, message: parsed.message });
      return;
    }
    dispatchInlineAiJob({ id: parsed.jobId, token: parsed.token });
    res.status(202).end();
  });
}

export const aiJobTestHooks = { tokenHash, workerOrigin, allowInlineWorkerFallback };
