import { afterEach, describe, expect, it } from "vitest";
import {
  AI_REQUEST_VERSION,
  AI_TOKEN_POLICY,
  CHARS_PER_TOKEN,
  budgetForAllowance,
  estimateRequestTokens,
  estimateTokens,
  estimateValueTokens,
  fitsTokenAllowance,
  getAiRequestPolicy,
  getWorkingTokenAllowance,
  measureRequest,
  observeReportedTokenAllowance,
  parseAllowanceHeader,
  parseReportedAllowanceTokens,
  resetWorkingTokenAllowance,
  shrinkWorkingTokenAllowance,
} from "./aiBudget";

afterEach(() => resetWorkingTokenAllowance());

describe("token estimation", () => {
  it("over-estimates rather than under-estimates, because under-counting is what produces a 413", () => {
    // A conservative divisor: JSON is punctuation-dense, so `length / 4` would
    // under-count these payloads.
    expect(CHARS_PER_TOKEN).toBeLessThan(4);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(320))).toBeGreaterThanOrEqual(100);
    expect(estimateTokens("a".repeat(640))).toBeGreaterThan(estimateTokens("a".repeat(320)));
    expect(estimateValueTokens({ context: "London", sample: 12 })).toBeGreaterThan(0);
    // An unserializable value must never throw.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(estimateValueTokens(cyclic)).toBeGreaterThan(0);
  });

  it("charges non-Latin journal labels at a full token per character", () => {
    // A tag written in Urdu, Arabic or with emoji is worth more tokens per
    // character than English JSON, so a plain character count would under-count it.
    const latin = estimateTokens("a".repeat(64));
    const urdu = estimateTokens("خ".repeat(64));
    expect(urdu).toBeGreaterThan(latin * 2);
    // Latin text keeps the documented divisor.
    expect(estimateTokens("a".repeat(320))).toBe(Math.ceil(320 / CHARS_PER_TOKEN) + 8);
  });

  it("counts the fixed request overhead as part of the prompt it is charged for", () => {
    const base = {
      model: "openai/gpt-oss-120b",
      payload: { totals: { closedTrades: 10 } },
      outputTokenBudget: 2_400,
      inputTokenBudget: 4_267,
      evidenceRows: 1,
      trades: 1,
      journalTrades: 10,
      trimmed: false,
    };
    const bare = measureRequest(base);
    const withOverhead = measureRequest({ ...base, overheadTokens: 1_200 });
    expect(bare.overheadTokens).toBe(0);
    expect(withOverhead.overheadTokens).toBe(1_200);
    expect(withOverhead.estimatedInputTokens).toBe(bare.estimatedInputTokens + 1_200);
    expect(withOverhead.estimatedTotalTokens).toBeGreaterThan(bare.estimatedTotalTokens);
  });

  it("charges the reserved output budget against the same allowance as the prompt", () => {
    // Groq bills max_completion_tokens against TPM even when the completion is
    // short, which is why input and output are budgeted together.
    expect(estimateRequestTokens(1_000, 2_400)).toBeGreaterThan(estimateRequestTokens(1_000, 0));
    expect(estimateRequestTokens(1_000, 2_400)).toBe(Math.round((1_000 + 2_400) * AI_TOKEN_POLICY.safetyMargin));
    expect(fitsTokenAllowance(4_000, 2_400, 8_000)).toBe(true);
    expect(fitsTokenAllowance(6_000, 2_400, 8_000)).toBe(false);
  });

  it("never budgets a prompt below the floor or above the ceiling", () => {
    expect(budgetForAllowance(8_000, 2_400)).toBeLessThanOrEqual(AI_TOKEN_POLICY.inputCeilingTokens);
    expect(budgetForAllowance(8_000, 2_400)).toBeGreaterThanOrEqual(AI_TOKEN_POLICY.minInputTokens);
    expect(budgetForAllowance(400, 2_400)).toBe(AI_TOKEN_POLICY.minInputTokens);
    expect(budgetForAllowance(5_000_000, 2_400)).toBe(AI_TOKEN_POLICY.inputCeilingTokens);
    // A larger allowance must never produce a smaller prompt.
    expect(budgetForAllowance(20_000, 2_400)).toBeGreaterThanOrEqual(budgetForAllowance(8_000, 2_400));
  });
});

describe("learning the account's real allowance", () => {
  it("reads the limit out of Groq's own 413 body", () => {
    const body = "rate_limit_exceeded · Request too large for model `openai/gpt-oss-120b` in organization `[redacted]` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 12000, please reduce your message size and try again.";
    expect(parseReportedAllowanceTokens(body)).toBe(8_000);
    expect(parseReportedAllowanceTokens("no numbers here")).toBeNull();
    expect(parseReportedAllowanceTokens("Allowance is 250000 tokens")).toBe(250_000);
  });

  it("reads Groq's rate-limit header, which is documented as always TPM", () => {
    expect(parseAllowanceHeader("8000")).toBe(8_000);
    expect(parseAllowanceHeader(" 250000 ")).toBe(250_000);
    expect(parseAllowanceHeader(null)).toBeNull();
    expect(parseAllowanceHeader("")).toBeNull();
    expect(parseAllowanceHeader("not-a-number")).toBeNull();
    expect(parseAllowanceHeader("0")).toBeNull();
  });

  it("records the provider's own limit in either direction, keeping headroom once", () => {
    resetWorkingTokenAllowance();
    expect(getWorkingTokenAllowance()).toBe(AI_TOKEN_POLICY.assumedTpmFloorTokens);
    // The stated limit is a fact, so a roomier tier is allowed to raise the
    // budget: the floor this module starts from is only an assumption.
    expect(observeReportedTokenAllowance(70_000)).toBeGreaterThan(8_000);
    // Lower for a tighter tier…
    expect(observeReportedTokenAllowance(8_000)).toBeLessThan(70_000);
    // …and idempotent, so the same fact is never discounted twice.
    const once = observeReportedTokenAllowance(8_000);
    expect(observeReportedTokenAllowance(8_000)).toBe(once);
    // A bogus number can never unbound a request.
    expect(observeReportedTokenAllowance(900_000_000)).toBeLessThanOrEqual(250_000);
    expect(observeReportedTokenAllowance(null)).toBe(getWorkingTokenAllowance());
    expect(observeReportedTokenAllowance(0)).toBe(getWorkingTokenAllowance());
  });

  it("makes the next attempt strictly smaller after a refused request, without reaching zero", () => {
    resetWorkingTokenAllowance();
    const first = shrinkWorkingTokenAllowance();
    expect(first).toBeLessThan(AI_TOKEN_POLICY.assumedTpmFloorTokens);
    expect(shrinkWorkingTokenAllowance()).toBeLessThan(first);
    // Repeated failures never drive the budget to zero.
    for (let i = 0; i < 20; i++) shrinkWorkingTokenAllowance();
    expect(getWorkingTokenAllowance()).toBeGreaterThanOrEqual(AI_TOKEN_POLICY.minInputTokens);
    expect(budgetForAllowance(getWorkingTokenAllowance(), 2_400)).toBeGreaterThanOrEqual(AI_TOKEN_POLICY.minInputTokens);
  });
});

describe("model request policy", () => {
  it("derives every request limit from the model, never from a call site", () => {
    const strict = getAiRequestPolicy("openai/gpt-oss-120b");
    expect(strict.model).toBe("openai/gpt-oss-120b");
    expect(strict.strictStructuredOutput).toBe(true);
    expect(strict.reasoningEffort).toBe("low");
    expect(strict.maxInputTokens).toBeGreaterThan(0);
    expect(strict.maxOutputTokens).toBe(AI_TOKEN_POLICY.maxOutputTokens);

    // A model without constrained decoding gets a smaller output reservation so
    // the prompt keeps more of the same allowance.
    const loose = getAiRequestPolicy("llama-3.3-70b-versatile");
    expect(loose.strictStructuredOutput).toBe(false);
    expect(loose.reasoningEffort).toBeNull();
    expect(loose.maxOutputTokens).toBeLessThan(strict.maxOutputTokens);

    // The request version participates in the cache key.
    expect(AI_REQUEST_VERSION).toBe("v2");
  });

  it("sizes a tight tier to fit the whole request inside one minute", () => {
    resetWorkingTokenAllowance();
    const policy = getAiRequestPolicy("openai/gpt-oss-120b");
    expect(estimateRequestTokens(policy.maxInputTokens, policy.maxOutputTokens)).toBeLessThanOrEqual(policy.allowanceTokens);
  });
});

describe("request metadata is safe to keep", () => {
  it("measures a payload without carrying its contents or any credential", () => {
    const stats = measureRequest({
      model: "openai/gpt-oss-120b",
      payload: { totals: { closedTrades: 1_000 }, evidence: [{ evidenceId: "abc" }], note: "PRIVATE_NOTE" },
      outputTokenBudget: 2_400,
      inputTokenBudget: 4_267,
      evidenceRows: 12,
      trades: 8,
      journalTrades: 1_000,
      trimmed: true,
    });
    const serialized = JSON.stringify(stats);
    expect(serialized).not.toContain("PRIVATE_NOTE");
    expect(serialized).not.toContain("gsk_");
    expect(stats.journalTrades).toBe(1_000);
    expect(stats.evidenceRows).toBe(12);
    expect(stats.trimmed).toBe(true);
    expect(stats.inputCharacters).toBeGreaterThan(0);
    expect(stats.estimatedTotalTokens).toBe(estimateRequestTokens(stats.estimatedInputTokens, 2_400));
  });
});
