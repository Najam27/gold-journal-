/**
 * Central AI token budgeting. Browser-safe: it imports nothing from `node:*` and
 * never touches a credential.
 *
 * Why this module exists
 * ----------------------
 * Groq rejects a request that does not fit the model's per-minute token
 * allowance **before** running inference, with:
 *
 *   HTTP 413 · "Request too large for model `…` … on tokens per minute (TPM)"
 *
 * Two facts drive the design:
 *
 *  1. Groq charges the prompt tokens **plus the requested `max_completion_tokens`**
 *     against that allowance, so reserving a large output budget makes *every*
 *     request too large even when the prompt itself is small. Input and output
 *     must therefore be budgeted together, never independently.
 *  2. Everything the request carries is charged, not just the dataset: the system
 *     prompt and the JSON schema sent as `response_format` are prompt tokens too.
 *     `measureRequest()` therefore takes the fixed per-request overhead as an
 *     input (see `ANALYSIS_PROMPT_OVERHEAD_TOKENS` in `aiPayload`), so a payload is
 *     never fitted into a budget that its own schema has already spent.
 *  3. The allowance depends on the account tier, which the app cannot know ahead
 *     of time. Rather than assert a plan limit, every request is sized against a
 *     conservative floor, and the app *learns* the real allowance out of the
 *     provider's rate-limit header or its 413 body and sizes against that.
 *
 * Nothing is hardcoded at a call site: every request path reads its budget from
 * `getAiRequestPolicy()`.
 */
import { isStrictSchemaModel, normalizeGroqModelId, supportsReasoningEffort } from "./aiCore";

/**
 * Bumped whenever the *payload shape* changes. It participates in the AI cache
 * key, so a format change can never serve a report built from the old prompt.
 */
export const AI_REQUEST_VERSION = "v2";

/**
 * Conservative characters-per-token divisor.
 *
 * There is no official tokenizer in the browser bundle, and JSON is far more
 * punctuation-dense than prose, so the usual "4 characters per token" rule
 * under-estimates these payloads. Dividing by a smaller constant over-estimates
 * the token count, which is the safe direction: an over-estimate costs a
 * slightly smaller prompt, an under-estimate costs a 413.
 */
export const CHARS_PER_TOKEN = 3.2;

/** Small fixed overhead per chat message envelope (role markers, separators). */
const MESSAGE_OVERHEAD_TOKENS = 8;

/** Central request policy. Every value is a budget expressed in estimated tokens. */
export const AI_TOKEN_POLICY = {
  /**
   * Floor we size against until the provider states its own number. This is not a
   * claim about any specific plan: Groq reports the account's real allowance on
   * every response (`x-ratelimit-limit-tokens`) and in the body of a 413 ("Limit
   * N"), those numbers replace this assumption, and it matches the documented
   * 8K TPM of `openai/gpt-oss-120b` so an unmeasured account is never more
   * optimistic than the smallest tier that can carry an analysis.
   */
  assumedTpmFloorTokens: 8_000,

  /**
   * Headroom kept between the estimated cost of a request and the allowance it is
   * sized against. This is the *only* discount applied to a stated limit: the
   * estimate itself already over-counts tokens, and the margin covers whatever
   * that estimate gets wrong.
   */
  safetyMargin: 1.2,

  /** Hard ceiling on prompt size, even when the account has plenty of headroom. */
  inputCeilingTokens: 12_000,

  /** Reserved `max_completion_tokens` for the structured report request. */
  maxOutputTokens: 2_400,

  /** Output budget for a chunk summarization request (much smaller by design). */
  chunkOutputTokens: 700,

  /** Never shrink a prompt below this while reacting to a 413. */
  minInputTokens: 1_400,

  /**
   * Floor for the *dataset* part of a prompt, once the fixed per-request
   * overhead (system prompt + response schema) has been subtracted. The complete
   * deterministic totals are the irreducible core of an analysis, so a request
   * is never shrunk below carrying them.
   */
  minPayloadTokens: 600,

  /** Upper bound on chunk requests for one analysis, so one action stays bounded. */
  maxChunkRequests: 4,
} as const;

let workingAllowanceTokens: number = AI_TOKEN_POLICY.assumedTpmFloorTokens;

/** The per-minute token ceiling every request path currently sizes against. */
export function getWorkingTokenAllowance(): number {
  return workingAllowanceTokens;
}

/**
 * Reads the provider's own allowance out of a 413/429 body, e.g.
 * `"… on tokens per minute (TPM): Limit 8000, Requested 12000, please reduce
 * your message size…"`. Returns null when the body does not state one.
 */
export function parseReportedAllowanceTokens(message: string): number | null {
  const limit = /(?:limit|allowance)\D{0,24}(\d{3,9})/i.exec(message) ?? /(\d{3,9})\s*(?:tokens? per minute|tpm)\b/i.exec(message);
  const parsed = Number(limit?.[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Hard ceiling on a *learned* allowance. It only exists so a bogus or
 * mis-scoped number can never unbound a request; 250K TPM is above every
 * published Groq per-minute limit for a chat model.
 */
const MAX_LEARNED_ALLOWANCE_TOKENS = 250_000;

/**
 * Reads Groq's own TPM number out of a rate-limit response header
 * (`x-ratelimit-limit-tokens`). Groq documents this header as always present and
 * always referring to tokens per minute, which makes it the authoritative source
 * for the account's real allowance — a fact, unlike this module's assumption.
 */
export function parseAllowanceHeader(value: string | null | undefined): number | null {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/**
 * Records an allowance the provider itself stated — Groq's
 * `x-ratelimit-limit-tokens` response header, or the "Limit N" in a 413/429
 * body.
 *
 * Unlike this module's starting assumption, that number is a fact, so it is
 * adopted in **either** direction: a roomier tier raises the budget (the
 * assumption is only a floor) and a tighter one lowers it. The number is taken
 * at face value: the headroom that keeps a request off the boundary is the
 * uncertainty margin in `estimateRequestTokens`, which is applied to every
 * request, so discounting the provider's own number as well would take the same
 * headroom twice.
 */
export function observeReportedTokenAllowance(reported: number | null): number {
  if (!reported || !Number.isFinite(reported) || reported <= 0) return workingAllowanceTokens;
  const capped = Math.min(Math.floor(reported), MAX_LEARNED_ALLOWANCE_TOKENS);
  workingAllowanceTokens = Math.max(AI_TOKEN_POLICY.minInputTokens, capped);
  return workingAllowanceTokens;
}

/**
 * Sizes the next attempt strictly below the request that was just refused.
 *
 * Deliberately blind to the reported number: it is the fallback used only when a
 * refusal stated nothing about the account's allowance. It never reaches zero.
 */
export function shrinkWorkingTokenAllowance(): number {
  workingAllowanceTokens = Math.max(AI_TOKEN_POLICY.minInputTokens, Math.floor(workingAllowanceTokens * 0.75));
  return workingAllowanceTokens;
}

/**
 * Applies the budget consequence of one refused (413/429) request.
 *
 * `sizedAgainst` is the allowance the refused request was actually built for. The
 * transport has, before this point, adopted whatever limit the provider stated in
 * the refusal (its `x-ratelimit-limit-tokens` header or the `Limit N` in the
 * body, both scaled by the headroom fraction). When that made the working budget
 * smaller than the refused request, the fact has already been accounted for once
 * and is the fix — stepping down again would discount the same evidence twice and
 * needlessly starve the retry. Only a refusal that stated nothing (budget
 * unchanged) falls back to the blind step-down.
 */
export function recordRefusedRequest(sizedAgainst: number): number {
  if (workingAllowanceTokens < sizedAgainst) return workingAllowanceTokens;
  return shrinkWorkingTokenAllowance();
}

/** Restores the conservative default (used by tests and by a full reset). */
export function resetWorkingTokenAllowance(): void {
  workingAllowanceTokens = AI_TOKEN_POLICY.assumedTpmFloorTokens;
}

/** The prompt budget that fits this allowance alongside a reserved output budget. */
export function budgetForAllowance(allowanceTokens: number, outputTokens: number): number {
  const usable = Math.round(allowanceTokens / AI_TOKEN_POLICY.safetyMargin) - outputTokens;
  return Math.max(AI_TOKEN_POLICY.minInputTokens, Math.min(AI_TOKEN_POLICY.inputCeilingTokens, usable));
}

/** Per-model request policy returned by `getAiRequestPolicy()`. */
export type AiRequestPolicy = {
  model: string;
  /** Estimated prompt budget for one request. */
  maxInputTokens: number;
  /** Reserved `max_completion_tokens` for one request. */
  maxOutputTokens: number;
  /** True when the model supports `response_format: json_schema, strict: true`. */
  strictStructuredOutput: boolean;
  /** Groq `reasoning_effort` value, or null when the model does not accept it. */
  reasoningEffort: "low" | "medium" | "high" | null;
  /** Allowance the budget was derived from. */
  allowanceTokens: number;
};

/**
 * The single source of truth for "how big may this request be".
 *
 * Model-specific behaviour (strict structured output, reasoning control) comes
 * from the central model configuration in `aiCore`, so changing the model changes
 * the request policy instead of requiring edits at each call site.
 */
export function getAiRequestPolicy(model: string, allowanceTokens: number = getWorkingTokenAllowance()): AiRequestPolicy {
  const id = normalizeGroqModelId(model);
  const strict = isStrictSchemaModel(id);
  // A model without constrained decoding writes more filler before it reaches
  // the JSON, so its output is trimmed to leave the prompt more of the budget.
  const maxOutputTokens = strict ? AI_TOKEN_POLICY.maxOutputTokens : Math.round(AI_TOKEN_POLICY.maxOutputTokens * 0.75);
  return {
    model: id,
    maxInputTokens: budgetForAllowance(allowanceTokens, maxOutputTokens),
    maxOutputTokens,
    strictStructuredOutput: strict,
    reasoningEffort: supportsReasoningEffort(id) ? "low" : null,
    allowanceTokens,
  };
}

/**
 * Conservative token estimate for one string. Deliberately pessimistic: it
 * over-counts rather than under-counts, because under-counting is what produces
 * a 413.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Non-ASCII text is the one place a character count can *under*-count tokens:
  // a journal tag or emotion written in Urdu, Arabic or with emoji can be worth
  // more tokens per character than English JSON. Those characters are charged a
  // full token each, which keeps the estimate pessimistic for every script.
  const nonAscii = countNonAscii(text);
  const ascii = text.length - nonAscii;
  return Math.ceil(ascii / CHARS_PER_TOKEN + nonAscii) + MESSAGE_OVERHEAD_TOKENS;
}

/** Counts characters outside the ASCII range without copying the string. */
function countNonAscii(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) count += 1;
  }
  return count;
}

/** Estimated tokens for a JSON-serializable value. */
export function estimateValueTokens(value: unknown): number {
  try {
    return estimateTokens(JSON.stringify(value) ?? "");
  } catch {
    return estimateTokens(String(value ?? ""));
  }
}

/**
 * Total estimated tokens a request is charged for: the prompt plus the output
 * budget reserved through `max_completion_tokens`, with the safety margin on top.
 */
export function estimateRequestTokens(inputTokens: number, outputTokens: number): number {
  return Math.round((inputTokens + outputTokens) * AI_TOKEN_POLICY.safetyMargin);
}

/** True when this request fits the allowance the app currently sizes against. */
export function fitsTokenAllowance(inputTokens: number, outputTokens: number, allowanceTokens = workingAllowanceTokens): boolean {
  return estimateRequestTokens(inputTokens, outputTokens) <= allowanceTokens;
}

/**
 * Credential-free, journal-content-free metadata about one request. Safe to log
 * and safe to show in a diagnostic panel: counts, sizes, and the model id only —
 * never the key and never the journal text.
 */
export type AiRequestStats = {
  model: string;
  /** Characters in the serialized prompt. */
  inputCharacters: number;
  /** Estimated prompt tokens. */
  estimatedInputTokens: number;
  /** Reserved output budget. */
  outputTokenBudget: number;
  /** Estimated tokens charged against the allowance, after the margin. */
  estimatedTotalTokens: number;
  /** Context rows (each carrying an evidence id) included in the request. */
  evidenceRows: number;
  /** Representative trades included in the request. */
  trades: number;
  /** Closed trades the deterministic analysis covers. */
  journalTrades: number;
  /** Prompt budget the builder was allowed to use, including fixed overhead. */
  inputTokenBudget: number;
  /**
   * Estimated tokens of the fixed part of the request that is not the dataset:
   * the system prompt and the JSON schema sent as `response_format`. Groq charges
   * these against the same allowance as the dataset, so they are part of the
   * measurement rather than an unaccounted extra.
   */
  overheadTokens: number;
  /** True when the builder had to drop candidate evidence to fit the budget. */
  trimmed: boolean;
};

/** Measures a payload and returns the safe metadata above. */
export function measureRequest(input: {
  model: string;
  payload: unknown;
  outputTokenBudget: number;
  inputTokenBudget: number;
  evidenceRows: number;
  trades: number;
  journalTrades: number;
  trimmed: boolean;
  /** Fixed tokens carried by every request with this prompt + schema. */
  overheadTokens?: number;
}): AiRequestStats {
  const overheadTokens = Math.max(0, Math.round(input.overheadTokens ?? 0));
  const serialized = (() => {
    try {
      return JSON.stringify(input.payload) ?? "";
    } catch {
      return String(input.payload ?? "");
    }
  })();
  // Everything the provider counts against the allowance: the dataset, plus the
  // system prompt and response schema that ride along with it.
  const estimatedInputTokens = estimateTokens(serialized) + overheadTokens;
  return {
    model: input.model,
    inputCharacters: serialized.length,
    estimatedInputTokens,
    outputTokenBudget: input.outputTokenBudget,
    estimatedTotalTokens: estimateRequestTokens(estimatedInputTokens, input.outputTokenBudget),
    evidenceRows: input.evidenceRows,
    trades: input.trades,
    journalTrades: input.journalTrades,
    inputTokenBudget: input.inputTokenBudget,
    overheadTokens,
    trimmed: input.trimmed,
  };
}
