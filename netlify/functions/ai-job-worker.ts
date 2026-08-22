import type { Config } from "@netlify/functions";
import { runAiJob } from "../../server/aiJobs";

export default async (request: Request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const token = request.headers.get("X-Gold-Journal-AI-Dispatch") || "";
  const body = await request.json().catch(() => null) as { jobId?: unknown } | null;
  const jobId = typeof body?.jobId === "string" ? body.jobId : "";
  if (!token || !/^[A-Za-z0-9_-]{36,64}$/.test(token) || !/^[0-9a-f-]{36}$/i.test(jobId)) return new Response("Invalid background request", { status: 400 });
  await runAiJob(jobId, token);
  return new Response(null, { status: 204 });
};

export const config: Config = { background: true, path: "/.netlify/functions/ai-job-worker" };
