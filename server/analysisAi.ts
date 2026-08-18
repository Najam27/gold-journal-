import { createHash } from "node:crypto";
import { z } from "zod";
import { compactAnalysisForAi, type AnalysisResult, type Confidence } from "@shared/analysisEngine";

const DEFAULT_AI_TIMEOUT_MS = 20_000;
const AI_CACHE_TTL_MS = 15 * 60_000;
const AI_CACHE_MAX = 128;
const aiCache = new Map<string, { expiresAt: number; result: AiOutcome }>();

const evidenceItem = z.object({ label: z.string().max(160), claim: z.string().max(1_000), sample: z.number().finite().nonnegative(), metrics: z.record(z.string(), z.number().finite()), evidence: z.string().max(1_000), confidence: z.enum(["HIGH", "MEDIUM", "LOW"]) });
const hypothesis = z.object({ title: z.string().max(160), statement: z.string().max(1_000), evidence: z.array(z.string().max(500)).max(8), confidence: z.enum(["HIGH", "MEDIUM", "LOW"]), nextTest: z.string().max(500) });
const experiment = z.object({ name: z.string().max(160), compare: z.string().max(500), measure: z.array(z.string().max(120)).max(8), requiredSample: z.number().finite().int().nonnegative(), caution: z.string().max(500) });
const aiReportSchema = z.object({
  executiveSummary: z.string().max(2_000),
  strongestEdges: z.array(evidenceItem).max(10),
  weakestContexts: z.array(evidenceItem).max(10),
  sessionAnalysis: z.array(evidenceItem).max(20),
  timeframeAnalysis: z.array(evidenceItem).max(20),
  levelAnalysis: z.array(evidenceItem).max(30),
  setupAnalysis: z.array(evidenceItem).max(30),
  winLossDifferences: z.object({ winProfile: z.array(z.string().max(500)).max(10), lossProfile: z.array(z.string().max(500)).max(10), keyDifferences: z.array(z.string().max(500)).max(10), potentialLeaks: z.array(z.string().max(500)).max(10) }),
  behavioralLeaks: z.array(z.string().max(500)).max(12),
  edgeHypotheses: z.array(hypothesis).max(10),
  experiments: z.array(experiment).max(10),
  playbook: z.object({ bestConditions: z.array(z.string().max(500)).max(12), weakConditions: z.array(z.string().max(500)).max(12), bestSession: z.string().max(300), bestTimeframe: z.string().max(300), bestLevels: z.array(z.string().max(300)).max(12), bestSetups: z.array(z.string().max(300)).max(12), bestDirection: z.string().max(300), commonFailureConditions: z.array(z.string().max(500)).max(12), tradeManagementLeaks: z.array(z.string().max(500)).max(12), currentEdgeHypotheses: z.array(z.string().max(500)).max(12), nextExperiments: z.array(z.string().max(500)).max(12) }),
  dataQuality: z.object({ missing: z.array(z.string().max(500)).max(20), warnings: z.array(z.string().max(500)).max(20) }),
  warnings: z.array(z.string().max(500)).max(20),
});

export type AiReport = z.infer<typeof aiReportSchema>;
export type AiOutcome = { available: boolean; cached: boolean; model: string | null; report: AiReport | null; message?: string };

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    executiveSummary: { type: "string" }, strongestEdges: { type: "array", items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, claim: { type: "string" }, sample: { type: "number" }, metrics: { type: "object", additionalProperties: { type: "number" } }, evidence: { type: "string" }, confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] } }, required: ["label", "claim", "sample", "metrics", "evidence", "confidence"] } }, weakestContexts: { type: "array", items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, claim: { type: "string" }, sample: { type: "number" }, metrics: { type: "object", additionalProperties: { type: "number" } }, evidence: { type: "string" }, confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] } }, required: ["label", "claim", "sample", "metrics", "evidence", "confidence"] } }, sessionAnalysis: { type: "array", items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, claim: { type: "string" }, sample: { type: "number" }, metrics: { type: "object", additionalProperties: { type: "number" } }, evidence: { type: "string" }, confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] } }, required: ["label", "claim", "sample", "metrics", "evidence", "confidence"] } }, timeframeAnalysis: { type: "array", items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, claim: { type: "string" }, sample: { type: "number" }, metrics: { type: "object", additionalProperties: { type: "number" } }, evidence: { type: "string" }, confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] } }, required: ["label", "claim", "sample", "metrics", "evidence", "confidence"] } }, levelAnalysis: { type: "array", items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, claim: { type: "string" }, sample: { type: "number" }, metrics: { type: "object", additionalProperties: { type: "number" } }, evidence: { type: "string" }, confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] } }, required: ["label", "claim", "sample", "metrics", "evidence", "confidence"] } }, setupAnalysis: { type: "array", items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, claim: { type: "string" }, sample: { type: "number" }, metrics: { type: "object", additionalProperties: { type: "number" } }, evidence: { type: "string" }, confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] } }, required: ["label", "claim", "sample", "metrics", "evidence", "confidence"] } }, winLossDifferences: { type: "object", additionalProperties: false, properties: { winProfile: { type: "array", items: { type: "string" } }, lossProfile: { type: "array", items: { type: "string" } }, keyDifferences: { type: "array", items: { type: "string" } }, potentialLeaks: { type: "array", items: { type: "string" } } }, required: ["winProfile", "lossProfile", "keyDifferences", "potentialLeaks"] }, behavioralLeaks: { type: "array", items: { type: "string" } }, edgeHypotheses: { type: "array", items: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, statement: { type: "string" }, evidence: { type: "array", items: { type: "string" } }, confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] }, nextTest: { type: "string" } }, required: ["title", "statement", "evidence", "confidence", "nextTest"] } }, experiments: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, compare: { type: "string" }, measure: { type: "array", items: { type: "string" } }, requiredSample: { type: "number" }, caution: { type: "string" } }, required: ["name", "compare", "measure", "requiredSample", "caution"] } }, playbook: { type: "object", additionalProperties: false, properties: { bestConditions: { type: "array", items: { type: "string" } }, weakConditions: { type: "array", items: { type: "string" } }, bestSession: { type: "string" }, bestTimeframe: { type: "string" }, bestLevels: { type: "array", items: { type: "string" } }, bestSetups: { type: "array", items: { type: "string" } }, bestDirection: { type: "string" }, commonFailureConditions: { type: "array", items: { type: "string" } }, tradeManagementLeaks: { type: "array", items: { type: "string" } }, currentEdgeHypotheses: { type: "array", items: { type: "string" } }, nextExperiments: { type: "array", items: { type: "string" } } }, required: ["bestConditions", "weakConditions", "bestSession", "bestTimeframe", "bestLevels", "bestSetups", "bestDirection", "commonFailureConditions", "tradeManagementLeaks", "currentEdgeHypotheses", "nextExperiments"] }, dataQuality: { type: "object", additionalProperties: false, properties: { missing: { type: "array", items: { type: "string" } }, warnings: { type: "array", items: { type: "string" } } }, required: ["missing", "warnings"] }, warnings: { type: "array", items: { type: "string" } },
  },
  required: ["executiveSummary", "strongestEdges", "weakestContexts", "sessionAnalysis", "timeframeAnalysis", "levelAnalysis", "setupAnalysis", "winLossDifferences", "behavioralLeaks", "edgeHypotheses", "experiments", "playbook", "dataQuality", "warnings"],
} as const;

const systemPrompt = "You are a trading-performance analyst, not a market signal generator. You do not predict markets, recommend a BUY or SELL, promise outcomes, or invent statistics. You only interpret the supplied deterministic journal dataset. Every numerical statement must be traceable to a supplied row or aggregate. When evidence is insufficient, say so. Distinguish observed evidence from hypotheses. Use the supplied evidenceTier and confidence; never upgrade confidence from intuition. Keep the exact JSON schema. Do not mention or request credentials.";

function config() { return { key: process.env.OPENROUTER_API_KEY?.trim() ?? "", model: process.env.OPENROUTER_MODEL?.trim() ?? "", fallback: process.env.OPENROUTER_FALLBACK_MODEL?.trim() ?? "" }; }
function cacheKey(userId: number, accountId: number, analysis: AnalysisResult) { const compact = JSON.stringify(compactAnalysisForAi(analysis)); return `${userId}:${accountId}:${analysis.version}:${createHash("sha256").update(compact).digest("hex")}`; }
function extractJson(value: unknown) { const text = String(value ?? "").trim(); const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i); return JSON.parse(fenced ? fenced[1] : text); }
function removeExpiredCache() { const now = Date.now(); for (const [key, value] of Array.from(aiCache.entries())) if (value.expiresAt <= now) aiCache.delete(key); while (aiCache.size > AI_CACHE_MAX) aiCache.delete(aiCache.keys().next().value!); }

function allowedNumbers(value: unknown) { const matches = JSON.stringify(value).match(/-?\d+(?:\.\d+)?/g) ?? []; const values = new Set<number>([0]); for (const match of matches) { const number = Number(match); if (Number.isFinite(number)) { values.add(number); values.add(Number(number.toFixed(2))); values.add(Math.round(number)); } } return values; }
function hasOnlyGroundedNumbers(report: AiReport, compact: unknown) { const allowed = allowedNumbers(compact); const matches = JSON.stringify(report).match(/-?\d+(?:\.\d+)?/g) ?? []; return matches.every(match => allowed.has(Number(match)) || allowed.has(Math.round(Number(match)))); }

async function callModel(model: string, compact: unknown, key: string) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENROUTER_TIMEOUT_MS ?? DEFAULT_AI_TIMEOUT_MS));
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": process.env.OPENROUTER_APP_URL?.trim() || "https://gold-journal.netlify.app", "X-Title": "Gold Journal Analysis" }, signal: controller.signal, body: JSON.stringify({ model, temperature: 0.1, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: JSON.stringify(compact) }], response_format: { type: "json_schema", json_schema: { name: "gold_journal_analysis", strict: true, schema: responseSchema } } }) });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
    const parsed = aiReportSchema.safeParse(extractJson(body?.choices?.[0]?.message?.content));
    if (!parsed.success) throw new Error("OpenRouter returned invalid structured analysis");
    if (!hasOnlyGroundedNumbers(parsed.data, compact)) throw new Error("OpenRouter returned an ungrounded numerical claim");
    return parsed.data;
  } finally { clearTimeout(timeout); }
}

export async function analyzeWithOpenRouter(userId: number, accountId: number, analysis: AnalysisResult): Promise<AiOutcome> {
  removeExpiredCache(); const settings = config(); if (!settings.key || !settings.model) return { available: false, cached: false, model: settings.model || null, report: null, message: "AI analysis is not configured. Deterministic analysis remains available." };
  const key = cacheKey(userId, accountId, analysis); const cached = aiCache.get(key); if (cached && cached.expiresAt > Date.now()) return { ...cached.result, cached: true };
  const started = Date.now(); let selectedModel = settings.model;
  try {
    let report: AiReport;
    try { report = await callModel(settings.model, compactAnalysisForAi(analysis), settings.key); }
    catch (error) { if (!settings.fallback || settings.fallback === settings.model) throw error; selectedModel = settings.fallback; report = await callModel(settings.fallback, compactAnalysisForAi(analysis), settings.key); }
    const result: AiOutcome = { available: true, cached: false, model: selectedModel, report };
    aiCache.set(key, { expiresAt: Date.now() + AI_CACHE_TTL_MS, result });
    console.info("[analysis-ai]", JSON.stringify({ userId, accountId, model: selectedModel, success: true, cached: false, latencyMs: Date.now() - started }));
    return result;
  } catch (error) {
    console.warn("[analysis-ai]", JSON.stringify({ userId, accountId, model: selectedModel || null, success: false, latencyMs: Date.now() - started, reason: error instanceof Error ? error.message : "provider_failure" }));
    return { available: false, cached: false, model: selectedModel || null, report: null, message: "AI analysis temporarily unavailable. Deterministic analysis remains available." };
  }
}

export const aiTestHooks = { clearCache: () => aiCache.clear(), cacheSize: () => aiCache.size, confidenceValues: ["HIGH", "MEDIUM", "LOW"] satisfies Confidence[] };
