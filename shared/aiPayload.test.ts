import { afterEach, describe, expect, it } from "vitest";
import { AI_TOKEN_POLICY, estimateRequestTokens, getAiRequestPolicy, resetWorkingTokenAllowance } from "./aiBudget";
import { ANALYSIS_RESPONSE_SCHEMA } from "./aiCore";
import { buildAnalysis, type AnalysisTrade } from "./analysisEngine";
import {
  ANALYSIS_PROMPT_OVERHEAD_TOKENS,
  buildCoreContext,
  collectDimensionCandidates,
  fitSinglePayload,
  planAiRequest,
  selectRepresentativeTrades,
  type CompactTrade,
} from "./aiPayload";

afterEach(() => resetWorkingTokenAllowance());

const SETUPS = ["A", "B", "C", "D"];
const SESSIONS = ["London", "New York", "Asia"];
const TIMEFRAMES = ["M5", "M15", "H1"];
const LEVELS = ["Support", "Resistance", "Supply", "Demand"];

/**
 * A deterministic synthetic journal. The shape mirrors the real trade rows the
 * analysis engine consumes, including the fields that must never reach an AI
 * request (`notes`, `screenshotKey`).
 */
function journal(count: number): AnalysisTrade[] {
  return Array.from({ length: count }, (_, index) => {
    const win = index % 3 !== 0;
    const day = String((index % 27) + 1).padStart(2, "0");
    return {
      id: index + 1,
      tradeDate: `2026-01-${day}`,
      result: win ? "WIN" : "LOSS",
      pnl: win ? 40 + (index % 7) * 5 : -(20 + (index % 5) * 3),
      risk: 20 + (index % 4) * 5,
      reward: 60 + (index % 6) * 5,
      session: SESSIONS[index % SESSIONS.length],
      timeframe: TIMEFRAMES[index % TIMEFRAMES.length],
      level: LEVELS[index % LEVELS.length],
      setupQuality: SETUPS[index % SETUPS.length],
      direction: index % 2 ? "SELL" : "BUY",
      mistake: index % 11 === 0 ? "Revenge entry" : "",
      holdQuality: index % 5 === 0 ? "Cut early" : "Held to plan",
      patienceScore: (index % 10) + 1,
      notes: `PRIVATE_NOTE_${index}`,
      screenshotKey: `shots/${index}.png`,
      openTime: `2026-01-${day}T09:00:00Z`,
      closeTime: `2026-01-${day}T09:${String(index % 60).padStart(2, "0")}:00Z`,
    } satisfies AnalysisTrade;
  });
}

function serialized(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

describe("representative trade selection", () => {
  it("is deterministic and never random, so the same journal always sends the same trades", () => {
    const trades = journal(200);
    const first = selectRepresentativeTrades(trades, 12);
    const second = selectRepresentativeTrades(trades, 12);
    expect(first).toEqual(second);
    expect(first).toHaveLength(12);
  });

  it("keeps the recent activity, both extremes, the largest risk, and every tagged mistake", () => {
    const trades = journal(100);
    const picked = selectRepresentativeTrades(trades, 12);
    const refs = new Set(picked.map(trade => trade.ref));
    // Something from the tail of the journal: recent behaviour is always included.
    expect(picked.some(trade => trade.ref >= trades.length - 5)).toBe(true);
    // Both directions of the P&L distribution are represented.
    expect(picked.some(trade => trade.result === "WIN")).toBe(true);
    expect(picked.some(trade => trade.result === "LOSS")).toBe(true);
    // A tagged mistake is present, because that is the behavioural evidence.
    expect(picked.some(trade => trade.mistake === "Revenge entry")).toBe(true);
    expect(refs.size).toBe(picked.length);
  });

  it("sends structured fields only: no notes, no screenshot keys, no database metadata", () => {
    const picked = selectRepresentativeTrades(journal(50), 12);
    const text = serialized(picked);
    expect(text).not.toContain("PRIVATE_NOTE");
    expect(text).not.toContain("screenshotKey");
    expect(text).not.toContain("shots/");
    expect(text).not.toContain("openTime");
    for (const trade of picked) {
      expect(Object.keys(trade).sort()).toEqual([
        "date",
        "direction",
        "durationMinutes",
        "holdQuality",
        "level",
        "mistake",
        "patienceScore",
        "pnl",
        "rMultiple",
        "ref",
        "result",
        "reward",
        "risk",
        "session",
        "setup",
        "timeframe",
      ]);
    }
  });

  it("skips still-open trades and stays bounded by the limit", () => {
    const trades: AnalysisTrade[] = [...journal(20), { tradeDate: "2026-02-01", result: "OPEN", pnl: null }];
    const picked = selectRepresentativeTrades(trades, 5);
    expect(picked).toHaveLength(5);
    expect(picked.some(trade => trade.result === "OPEN")).toBe(false);
    expect(selectRepresentativeTrades([], 12)).toEqual([]);
    expect(selectRepresentativeTrades(trades, 0)).toEqual([]);
  });
});

describe("the compact payload carries complete statistics and a bounded detail set", () => {
  it("keeps every deterministic total for the whole period while trimming detail to fit", () => {
    const trades = journal(1_000);
    const analysis = buildAnalysis(trades);
    const core = buildCoreContext(analysis);
    const candidates = collectDimensionCandidates(analysis);
    const policy = getAiRequestPolicy("openai/gpt-oss-120b");
    const fitted = fitSinglePayload({
      core,
      candidates,
      trades: selectRepresentativeTrades(trades, 12),
      maxInputTokens: policy.maxInputTokens,
      outputTokenBudget: policy.maxOutputTokens,
      model: policy.model,
    });

    // The statistics represent the complete selected dataset, trimmed or not.
    expect(fitted.payload.totals.closedTrades).toBe(analysis.overview.sample);
    expect(fitted.payload.totals.netPnl).toBe(analysis.overview.netPnl);
    expect(fitted.payload.totals.winRate).toBe(analysis.overview.winRate);
    // A representative subset, never the whole database.
    expect(fitted.payload.trades.length).toBeLessThanOrEqual(12);
    expect(fitted.payload.trades.length).toBeGreaterThan(0);
    // The manifest and the evidence list are one representation, not two.
    const ids = fitted.payload.evidence.map(entry => entry.evidenceId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(serialized(fitted.payload)).not.toContain("PRIVATE_NOTE");
  });

  it("shrinks along the fixed ladder instead of blindly cutting JSON", () => {
    const trades = journal(400);
    const analysis = buildAnalysis(trades);
    const core = buildCoreContext(analysis);
    const candidates = collectDimensionCandidates(analysis);
    const tight = fitSinglePayload({
      core,
      candidates,
      trades: selectRepresentativeTrades(trades, 12),
      maxInputTokens: AI_TOKEN_POLICY.minInputTokens,
      outputTokenBudget: 2_400,
      model: "openai/gpt-oss-120b",
    });
    const roomy = fitSinglePayload({
      core,
      candidates,
      trades: selectRepresentativeTrades(trades, 12),
      maxInputTokens: 12_000,
      outputTokenBudget: 2_400,
      model: "openai/gpt-oss-120b",
    });
    expect(tight.payload.evidence.length).toBeLessThan(roomy.payload.evidence.length);
    expect(tight.payload.trades.length).toBeLessThanOrEqual(roomy.payload.trades.length);
    // Even at the tightest step the totals are intact and the payload is valid JSON.
    expect(tight.payload.totals.closedTrades).toBe(analysis.overview.sample);
    expect(serialized(tight.payload).length).toBeGreaterThan(0);
  });
});

describe("the fixed per-request overhead", () => {
  it("declares the shared evidence shape once, so the schema cannot outgrow the journal data", () => {
    const serialized = JSON.stringify(ANALYSIS_RESPONSE_SCHEMA);
    // The six analysis arrays all reuse one definition.
    expect(serialized.match(/"\$ref":"#\/\$defs\/evidenceItem"/g)).toHaveLength(6);
    // Inlined six times this cost ~2,500 of an 8,000-token per-minute allowance —
    // more than the evidence it describes. Keeping it declared once is the fix.
    expect(serialized.length).toBeLessThan(6_000);
    expect(ANALYSIS_PROMPT_OVERHEAD_TOKENS).toBeLessThan(2_000);
  });

  it("keeps every object strict-compatible: closed, with every property required", () => {
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.properties) {
        expect(record.additionalProperties).toBe(false);
        expect(record.required).toEqual(Object.keys(record.properties as Record<string, unknown>));
      }
      for (const value of Object.values(record)) walk(value);
    };
    walk(ANALYSIS_RESPONSE_SCHEMA);
  });

  it("leaves the dataset a real budget on the tightest usable tier", () => {
    const policy = getAiRequestPolicy("openai/gpt-oss-120b", AI_TOKEN_POLICY.assumedTpmFloorTokens);
    // The prompt budget must still have room beyond the system prompt, the schema
    // and the irreducible floor of complete totals.
    expect(policy.maxInputTokens).toBeGreaterThan(ANALYSIS_PROMPT_OVERHEAD_TOKENS + AI_TOKEN_POLICY.minPayloadTokens * 3);
  });
});

describe("request planning at every journal size", () => {
  it.each([10, 50, 100, 500, 1_000])("sends one measured request for %i trades", count => {
    const trades = journal(count);
    const analysis = buildAnalysis(trades);
    const plan = planAiRequest({
      analysis,
      trades: selectRepresentativeTrades(trades, 12),
      model: "openai/gpt-oss-120b",
      allowanceTokens: AI_TOKEN_POLICY.assumedTpmFloorTokens,
    });
    expect(plan.mode).toBe("single");
    // The measured request fits the account's own allowance with the output
    // budget already charged against it — this is the 413 fix.
    expect(plan.stats.estimatedTotalTokens).toBeLessThanOrEqual(plan.policy.allowanceTokens);
    expect(plan.stats.estimatedInputTokens).toBeLessThanOrEqual(plan.policy.maxInputTokens);
    expect(plan.stats.journalTrades).toBe(analysis.overview.sample);
    expect(plan.payload!.trades.length).toBeLessThanOrEqual(12);
    // Nothing resembling the old unbounded request: the whole payload stays in
    // the low tens of kilobytes even for a thousand trades.
    expect(plan.stats.inputCharacters).toBeLessThan(14_000);
    expect(serialized(plan.payload)).not.toContain("PRIVATE_NOTE");
  });

  it("never grows the request just because the journal grew", () => {
    const small = planAiRequest({
      analysis: buildAnalysis(journal(10)),
      trades: selectRepresentativeTrades(journal(10), 12),
      model: "openai/gpt-oss-120b",
      allowanceTokens: AI_TOKEN_POLICY.assumedTpmFloorTokens,
    });
    const huge = planAiRequest({
      analysis: buildAnalysis(journal(1_000)),
      trades: selectRepresentativeTrades(journal(1_000), 12),
      model: "openai/gpt-oss-120b",
      allowanceTokens: AI_TOKEN_POLICY.assumedTpmFloorTokens,
    });
    expect(huge.stats.estimatedInputTokens).toBeLessThanOrEqual(huge.policy.maxInputTokens);
    expect(huge.stats.estimatedInputTokens).toBeLessThanOrEqual(small.stats.estimatedInputTokens * 2);
  });

  it("still covers complete statistics on the tightest tier that can carry a request", () => {
    const trades = journal(1_000);
    const analysis = buildAnalysis(trades);
    // `openai/gpt-oss-120b` is an 8K TPM model: the smallest allowance an analysis
    // runs on, and therefore the tier where detail has to be trimmed hardest.
    const plan = planAiRequest({
      analysis,
      trades: selectRepresentativeTrades(trades, 12),
      model: "openai/gpt-oss-120b",
      allowanceTokens: AI_TOKEN_POLICY.assumedTpmFloorTokens,
    });
    expect(plan.stats.estimatedTotalTokens).toBeLessThanOrEqual(plan.policy.allowanceTokens);
    // Complete deterministic totals for the whole period, whatever else is trimmed,
    // and the request still names every closed trade in it.
    expect(plan.payload!.totals.closedTrades).toBe(analysis.overview.sample);
    expect(plan.stats.journalTrades).toBe(analysis.overview.sample);
    expect(plan.stats.evidenceRows).toBeGreaterThan(0);
    expect(plan.stats.trimmed).toBe(true);
    expect(plan.mode).toBe("single");
  });

  it("only chunks on a tier that can genuinely absorb several requests", () => {
    const trades = journal(1_000);
    const analysis = buildAnalysis(trades);
    const compact = selectRepresentativeTrades(trades, 12);

    // gpt-oss-120b on-demand is an 8K TPM tier: two chunk requests would each be
    // throttled, so the aggregation path is the correct plan.
    const tight = planAiRequest({ analysis, trades: compact, model: "openai/gpt-oss-120b", allowanceTokens: 8_000 });
    expect(tight.mode).toBe("single");

    // A roomier tier (for example a 70K TPM model) can afford a batch plan, and
    // every request in it stays inside the same shared minute.
    const roomy = planAiRequest({ analysis, trades: compact, model: "groq/compound", allowanceTokens: 70_000 });
    expect(roomy.mode).toBe("chunked");
    expect(roomy.chunks.length).toBeGreaterThanOrEqual(2);
    expect(roomy.chunks.length).toBeLessThanOrEqual(AI_TOKEN_POLICY.maxChunkRequests);
    for (const chunk of roomy.chunks) {
      expect(chunk.stats.estimatedTotalTokens).toBeLessThanOrEqual(roomy.policy.allowanceTokens);
      expect(chunk.stats.evidenceRows).toBeGreaterThan(0);
      // Slices share the complete totals so a batch can never see a partial picture.
      expect(chunk.payload.totals.closedTrades).toBe(analysis.overview.sample);
    }
    const spent = roomy.chunks.reduce((total, chunk) => total + chunk.stats.estimatedTotalTokens, 0);
    expect(spent).toBeLessThanOrEqual(roomy.policy.allowanceTokens);
    for (const chunk of roomy.chunks) {
      expect(serialized(chunk.payload)).not.toContain("PRIVATE_NOTE");
    }
  });

  it("bounded chunk request count keeps one user action bounded", () => {
    const trades = journal(1_000);
    const roomy = planAiRequest({
      analysis: buildAnalysis(trades),
      trades: selectRepresentativeTrades(trades, 12),
      model: "groq/compound",
      allowanceTokens: 250_000,
    });
    if (roomy.mode === "chunked") {
      expect(roomy.chunks.length).toBeLessThanOrEqual(AI_TOKEN_POLICY.maxChunkRequests);
      for (const chunk of roomy.chunks) {
        expect(estimateRequestTokens(chunk.stats.estimatedInputTokens, AI_TOKEN_POLICY.chunkOutputTokens)).toBeLessThanOrEqual(roomy.policy.allowanceTokens);
      }
    } else {
      expect(roomy.stats.estimatedTotalTokens).toBeLessThanOrEqual(roomy.policy.allowanceTokens);
    }
  });

  it("keeps the compact trade list chronological so the model reads the period in order", () => {
    const trades = journal(120);
    const selected: CompactTrade[] = selectRepresentativeTrades(trades, 12);
    const core = buildCoreContext(buildAnalysis(trades));
    const fitted = fitSinglePayload({
      core,
      candidates: collectDimensionCandidates(buildAnalysis(trades)),
      trades: selected,
      maxInputTokens: 12_000,
      outputTokenBudget: 2_400,
      model: "openai/gpt-oss-120b",
    });
    const dates = fitted.payload.trades.map(trade => trade.date);
    expect([...dates].sort()).toEqual(dates);
  });
});
