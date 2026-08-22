import { z } from "zod";
import type { RiskCalculation } from "@shared/riskCalculator";
import { getUserAiCredential } from "./userAiProviderVault";

export const DEFAULT_RISK_COACH_TIMEOUT_MS = 120_000;
const MIN_RISK_COACH_TIMEOUT_MS = 1_000;
const coachSchema = z.object({ readiness: z.enum(["VERIFY", "CAUTION", "UNAVAILABLE"]), summary: z.string().max(700), cautions: z.array(z.string().max(280)).max(6), verificationSteps: z.array(z.string().max(280)).min(1).max(6) });
const responseSchema = { type: "object", additionalProperties: false, properties: { readiness: { type: "string", enum: ["VERIFY", "CAUTION", "UNAVAILABLE"] }, summary: { type: "string" }, cautions: { type: "array", items: { type: "string" } }, verificationSteps: { type: "array", items: { type: "string" } } }, required: ["readiness", "summary", "cautions", "verificationSteps"] } as const;
const system = "You are a cautious trading-risk process coach. You receive a deterministic calculator output from an authenticated journal. Do not recommend BUY, SELL, holding, entry timing, price targets, or a trade. Do not predict markets, promise results, change the supplied math, or request credentials. Return only risk-process cautions and checks that the trader must verify in their MT5 terminal. If broker data is incomplete or warnings exist, use CAUTION or UNAVAILABLE. Keep the exact JSON schema.";
export type RiskCoachOutcome = { available: boolean; coach: z.infer<typeof coachSchema> | null; message?: string; pending?: boolean; jobId?: string };
export function resolveRiskCoachTimeoutMs(value = process.env.OPENROUTER_RISK_COACH_TIMEOUT_MS ?? process.env.OPENROUTER_TIMEOUT_MS) { const parsed = Number(value); if (!Number.isFinite(parsed)) return DEFAULT_RISK_COACH_TIMEOUT_MS; return Math.min(DEFAULT_RISK_COACH_TIMEOUT_MS, Math.max(MIN_RISK_COACH_TIMEOUT_MS, Math.floor(parsed))); }

export async function coachRiskWithOpenRouter(userId: number, calculation: RiskCalculation): Promise<RiskCoachOutcome> {
  const credential = await getUserAiCredential(userId);
  if (!credential) return { available: false, coach: null, message: "AI Risk Coach is not configured. Add your OpenRouter key in Options; the deterministic calculation remains available." };
  const compact = { basis: calculation.basis, capital: calculation.capital, riskPercent: calculation.riskPercent, riskAmount: calculation.riskAmount, stopDistance: calculation.stopDistance, stopTicks: calculation.stopTicks, lossPerLot: calculation.lossPerLot, lots: calculation.lots, actualRisk: calculation.actualRisk, symbol: calculation.symbol, currency: calculation.currency, valid: calculation.valid, warnings: calculation.warnings, verification: calculation.verification };
  const timeoutMs = resolveRiskCoachTimeoutMs(); const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new DOMException("AI risk coach timed out", "TimeoutError")), timeoutMs);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.key}`, "HTTP-Referer": process.env.OPENROUTER_APP_URL?.trim() || "https://gold-journal.netlify.app", "X-Title": "Gold Journal Risk Coach" }, signal: controller.signal, body: JSON.stringify({ model: credential.model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(compact) }], response_format: { type: "json_schema", json_schema: { name: "gold_journal_risk_coach", strict: true, schema: responseSchema } } }) });
    const body = await response.json().catch(() => null); if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
    const raw = String(body?.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""); const parsed = coachSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("invalid structured risk-coach response");
    const narrative = JSON.stringify(parsed.data).toLowerCase(); if (/\b(buy|sell|long|short|price target|guaranteed|enter now)\b/.test(narrative)) throw new Error("unsafe risk-coach response");
    return { available: true, coach: parsed.data };
  } catch (error) { const timedOut = error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError"); return { available: false, coach: null, message: timedOut ? `AI risk coach timed out after ${Math.round(timeoutMs / 1_000)} seconds. Verify the deterministic calculation in MT5 before trading.` : "AI risk coach is temporarily unavailable. Verify the deterministic calculation in MT5 before trading." }; }
  finally { clearTimeout(timeout); }
}
