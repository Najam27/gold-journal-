import { createHash } from "node:crypto";
import { aiEdgeHistory, aiExperimentHistory, aiReports } from "../drizzle/schema";
import { compactAnalysisForAi, type AnalysisResult } from "@shared/analysisEngine";
import { buildEvidenceManifest, type AiOutcome } from "./analysisAi";
import { getDb } from "./db";
import { and, desc, eq } from "./supabaseQuery";

export function analysisDataFingerprint(analysis: AnalysisResult) {
  return createHash("sha256").update(JSON.stringify({ version: analysis.version, data: compactAnalysisForAi(analysis) })).digest("hex");
}

export async function persistAiOutcome(userId: number, accountId: number, analysis: AnalysisResult, outcome: AiOutcome) {
  if (!outcome.available || !outcome.report || !outcome.model) return { persisted: false as const, reportId: null, dataFingerprint: analysisDataFingerprint(analysis) };
  const db = await getDb();
  if (!db) return { persisted: false as const, reportId: null, dataFingerprint: analysisDataFingerprint(analysis) };
  const dataFingerprint = analysisDataFingerprint(analysis);
  const manifest = buildEvidenceManifest(analysis);
  const report = outcome.report;
  const inserted = await db.insert(aiReports).values({ userId, accountId, analysisVersion: analysis.version, dataFingerprint, model: outcome.model, report, evidenceManifest: manifest }).onConflictDoNothing({ target: [aiReports.userId, aiReports.accountId, aiReports.dataFingerprint] }).returning({ id: aiReports.id });
  const reportId = inserted[0]?.id ?? (await db.select({ id: aiReports.id }).from(aiReports).where(and(eq(aiReports.userId, userId), eq(aiReports.accountId, accountId), eq(aiReports.dataFingerprint, dataFingerprint))).limit(1))[0]?.id;
  if (!reportId) throw new Error("AI report persistence did not return a report identifier.");

  const allEvidence = [...report.strongestEdges, ...report.weakestContexts, ...report.sessionAnalysis, ...report.timeframeAnalysis, ...report.levelAnalysis, ...report.setupAnalysis];
  const uniqueEvidence = Array.from(new Map(allEvidence.map(item => [item.evidenceId, item])).values());
  if (uniqueEvidence.length) await Promise.all(uniqueEvidence.map(item => db.insert(aiEdgeHistory).values({ reportId, userId, accountId, evidenceId: item.evidenceId, dimension: item.dimension, context: item.context, expectancy: item.expectancy.toFixed(6), sample: Math.round(item.sample), evidenceTier: item.evidenceTier, confidence: item.confidence, claimType: item.claimType }).onConflictDoNothing({ target: [aiEdgeHistory.reportId, aiEdgeHistory.evidenceId] })));
  if (report.experiments.length) await Promise.all(report.experiments.map(experiment => db.insert(aiExperimentHistory).values({ reportId, userId, accountId, name: experiment.name, compare: experiment.compare, measure: experiment.measure, requiredSample: experiment.requiredSample, caution: experiment.caution, status: "PLANNED" }).onConflictDoNothing({ target: [aiExperimentHistory.reportId, aiExperimentHistory.name] })));
  return { persisted: true as const, reportId, dataFingerprint };
}

export async function listAiReports(userId: number, accountId: number, limit = 20) {
  const db = await getDb();
  if (!db) throw new Error("Supabase database is unavailable. Please retry shortly.");
  return db.select({ id: aiReports.id, analysisVersion: aiReports.analysisVersion, dataFingerprint: aiReports.dataFingerprint, model: aiReports.model, report: aiReports.report, evidenceManifest: aiReports.evidenceManifest, createdAt: aiReports.createdAt }).from(aiReports).where(and(eq(aiReports.userId, userId), eq(aiReports.accountId, accountId))).orderBy(desc(aiReports.createdAt)).limit(limit);
}

export async function listAiExperiments(userId: number, accountId: number, limit = 50) {
  const db = await getDb();
  if (!db) throw new Error("Supabase database is unavailable. Please retry shortly.");
  return db.select().from(aiExperimentHistory).where(and(eq(aiExperimentHistory.userId, userId), eq(aiExperimentHistory.accountId, accountId))).orderBy(desc(aiExperimentHistory.createdAt)).limit(limit);
}

export async function updateAiExperiment(userId: number, accountId: number, experimentId: number, status: "PLANNED" | "RUNNING" | "COMPLETED" | "CANCELLED", outcome?: string | null) {
  const db = await getDb();
  if (!db) throw new Error("Supabase database is unavailable. Please retry shortly.");
  const updated = await db.update(aiExperimentHistory).set({ status, outcome: outcome ?? null, updatedAt: new Date() }).where(and(eq(aiExperimentHistory.id, experimentId), eq(aiExperimentHistory.userId, userId), eq(aiExperimentHistory.accountId, accountId))).returning({ id: aiExperimentHistory.id });
  if (!updated[0]) throw new Error("That AI experiment is unavailable.");
  return { success: true };
}
