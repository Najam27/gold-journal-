import { z } from "zod";
import type { RiskCalculation } from "@shared/riskCalculator";

const RISK_COACH_TIMEOUT_MS = 20_000;
const coachSchema = z.object({ readiness: z.enum(["VERIFY", "CAUTION", "UNAVAILABLE"]), summary: z.string().max(700), cautions: z.array(z.string().max(280)).max(6), verificationSteps: z.array(z.string().max(280)).min(1).max(6) });
const responseSchema = { type: "object", additionalProperties: false, properties: { readiness: { type: "string", enum: ["VERIFY", "CAUTION", "UNAVAILABLE"] }, summary: { type: "string" }, cautions: { type: "array", items: { type: "string" } }, verificationSteps: { type: "array", items: { type: "string" } } }, required: ["readiness", "summary", "cautions", "verificationSteps"] } as const;
const system = "You are a cautious trading-risk process coach. You receive a deterministic calculator output from an authenticated journal. Do not recommend BUY, SELL, holding, entry timing, price targets, or a trade. Do not predict markets, promise results, change the supplied math, or request credentials. Return only risk-process cautions and checks that the trader must verify in their MT5 terminal. If broker data is incomplete or warnings exist, use CAUTION or UNAVAILABLE. Keep the exact JSON schema.";
export type RiskCoachOutcome = { available: boolean; coach: z.infer<typeof coachSchema> | null; message?: string };

export async function coachRiskWithOpenRouter(calculation: RiskCalculation): Promise<RiskCoachOutcome> {
  const key = process.env.OPENROUTER_API_KEY?.trim(); const model = process.env.OPENROUTER_MODEL?.trim();
  if (!key || !model) return { available: false, coach: null, message: "AI risk coach is not configured. The deterministic calculation remains available." };
  const compact = { basis: calculation.basis, capital: calculation.capital, riskPercent: calculation.riskPercent, riskAmount: calculation.riskAmount, stopDistance: calculation.stopDistance, stopTicks: calculation.stopTicks, lossPerLot: calculation.lossPerLot, lots: calculation.lots, actualRisk: calculation.actualRisk, symbol: calculation.symbol, currency: calculation.currency, valid: calculation.valid, warnings: calculation.warnings, verification: calculation.verification };
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), RISK_COACH_TIMEOUT_MS);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": process.env.OPENROUTER_APP_URL?.trim() || "https://gold-journal.netlify.app", "X-Title": "Gold Journal Risk Coach" }, signal: controller.signal, body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(compact) }], response_format: { type: "json_schema", json_schema: { name: "gold_journal_risk_coach", strict: true, schema: responseSchema } } }) });
    const body = await response.json().catch(() => null); if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
    const raw = String(body?.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""); const parsed = coachSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error("invalid structured risk-coach response");
    const narrative = JSON.stringify(parsed.data).toLowerCase(); if (/\b(buy|sell|long|short|price target|guaranteed|enter now)\b/.test(narrative)) throw new Error("unsafe risk-coach response");
    return { available: true, coach: parsed.data };
  } catch (error) { return { available: false, coach: null, message: error instanceof DOMException && error.name === "AbortError" ? "AI risk coach timed out. Verify the deterministic calculation in MT5 before trading." : "AI risk coach is temporarily unavailable. Verify the deterministic calculation in MT5 before trading." }; }
  finally { clearTimeout(timeout); }
}
