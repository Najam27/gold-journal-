# Gold Journal — AI pipeline audit and dual-provider repair (2026-09-24)

**Scope:** the complete AI path from the Analysis / AI Mentor button click to the
provider request, response parsing, local validation, report persistence, and
rendering — plus the two production failures:

```text
Request too large
AI report failed local validation
AI returned an evidence claim that does not match the supplied evidence, so the report was rejected.
```

**Verdict:** both failures had a single, identifiable root cause each. Both are
fixed, and the AI layer is now a dual-provider (Google Gemini + Groq) system with
automatic fallback and a deterministic report that is always available.

---

## 1. Trace of the current pipeline (before the repair)

| Step | File / function | What it did |
| --- | --- | --- |
| UI action | `client/src/components/AnalysisDashboard.tsx` → `runAi`, `client/src/pages/GoldJournal.tsx` → `MentorView.run` | One explicit user click, an `AbortController`, a progress callback. No effect or re-render could start a second request. |
| Request planning | `shared/aiPayload.ts` → `planAiRequest`, `buildSynthesisPayload` | One canonical evidence representation, a complete-but-bounded dataset, a measured budget, and a fixed shrink ladder. Never sent unmeasured. |
| Budgeting | `shared/aiBudget.ts` → `getAiRequestPolicy`, `measureRequest`, `observeReportedTokenAllowance` | Sized the prompt **plus** the reserved output against a learned Groq TPM allowance, including the fixed system-prompt + JSON-schema overhead. |
| Model discovery | `client/src/lib/ai/groqClient.ts` → `listGroqModels`, `client/src/lib/ai/aiService.ts` → `resolveCompatibleModel` | Live `GET /models` per key, non-chat models filtered, retired selection repaired and re-persisted. |
| Transport | `groqClient.ts` → `requestGroqStructuredCompletion` | Strict `json_schema` where supported, one downgrade to `json_object`, bounded retries, 413 handling. |
| Validation | `shared/aiCore.ts` → `hasOnlyGroundedNumbers`, `validateEvidenceReport`; called by `aiService.validateReport` | **Rejected the entire report** when any single claim failed. |
| Rendering | `AiReport` in `AnalysisDashboard.tsx`, mentor report block in `GoldJournal.tsx` | Rendered `outcome.report`; when `available` was false the whole report disappeared. |

### Confirmed non-issues

* The journal is never sent whole: only compact aggregates, a ranked evidence
  subset, and a small representative trade set.
* Screenshots, notes, plans, mistakes, and psychology text never reach a
  provider (`CompactTrade` carries structured fields only).
* One click = one logical request; React StrictMode double-effects and
  double-clicks join the in-flight promise (`inFlight` map keyed by feature +
  dataset fingerprint).
* Retries are bounded (3 transient attempts, one 413 re-plan, one schema
  downgrade per provider).
* Invalid keys, rate limits, and quotas were already classified distinctly from
  validation failures.

---

## 2. Root cause — `Request too large`

**Where:** `groqClient.classifyStatus` (HTTP 413) surfaced by
`aiService.analyzeJournal`'s single re-plan path.

The request really did exceed Groq's per-minute token allowance. Two contributing
factors:

1. **The advertised allowance was a floor, not a fact.** `AI_TOKEN_POLICY.assumedTpmFloorTokens`
   is 8,000; the request was sized at `budgetForAllowance(8000, 2400) ≈ 4,267`
   prompt tokens. On a tighter tier the request is refused, and the single
   step-down path could only shrink once before giving up — which is exactly the
   user-visible `Request too large`.
2. **The strict response schema is charged as prompt tokens.** The schema alone
   is ≈1,600 estimated tokens of every request; before it was de-duplicated with
   `$defs` it was ≈2,500 of an 8,000-token allowance.

**Fix (kept and extended):** the request remains measured (dataset + system
prompt + schema + reserved output), the provider's own stated limit is still
adopted from `x-ratelimit-limit-tokens` or the `Limit N` in the 413 body, a 413 is
still never retried unchanged, and the shrink retry is still exactly once. What
changed is that an oversized request is no longer the end of the story: the other
provider is tried, and if it also fails the deterministic report is rendered.

---

## 3. Root cause — `AI returned an evidence claim that does not match the supplied evidence`

**Where:** `shared/aiCore.ts` → `validateEvidenceReport`, called from
`aiService.validateReport`:

```ts
for (const row of rows) {
  const source = byId.get(row.evidenceId);
  if (!source || source.dimension !== row.dimension || ... ||
      Math.abs(source.expectancy - row.expectancy) > 0.0001 ||
      source.profitFactor !== row.profitFactor || source.averageR !== row.averageR ||
      source.maxDrawdown !== row.maxDrawdown || source.evidenceTier !== row.evidenceTier) return false;
}
```

Three separate failures in one function:

1. **All-or-nothing.** A single mismatched row (or one hypothesis citing an id
   that was trimmed out of the payload by the budget ladder) rejected **every**
   field of the report.
2. **Exact float equality.** `profitFactor`, `averageR`, and `maxDrawdown` were
   compared with `!==`. A model that echoes `2.31` for `2.3142857…` fails, which
   is the single most common cause of this error in practice.
3. **Brittle numeric grounding.** `hasOnlyGroundedNumbers` judged the entire
   serialized report; one hallucinated number anywhere discarded everything else
   the model got right.

**Fix:** validation is now repair-first (`shared/aiCore.ts` → `sanitizeAiReport`).

* Every evidence row is **rebuilt from the deterministic manifest entry its
  `evidenceId` names** — sample, wins, losses, expectancy, profit factor, average
  R, max drawdown, evidence tier, and confidence all come from the local engine.
  An AI claim can therefore never override a verified calculation or upgrade a
  confidence tier.
* A row citing an id that was never supplied is dropped (and counted), not fatal.
* A narrative sentence carrying an ungrounded number is dropped (and counted);
  the remaining sentences are kept.
* A hypothesis with no valid evidence id is dropped; a hypothesis with some valid
  ids keeps them.
* Banned market-signal phrasing is stripped from the affected strings only.
* The result always satisfies `aiReportSchema`, so the report is shown rather
  than thrown away. Only a response that is not a JSON object at all is a
  provider failure.

---

## 4. Dual-provider behaviour now implemented

| Requirement | Implementation |
| --- | --- |
| User enters both keys in Settings | `client/src/components/UserAiProviderSettings.tsx` renders one card per provider (`gemini`, `groq`) with an independent password field, model picker, test, save/replace, save-model, and delete. |
| Browser-only keys | `client/src/lib/ai/aiStorage.ts` stores one record, `gold-journal.ai.providers:v1`, in `localStorage`. Keys never reach a backend and never appear in a URL. |
| Dynamic model discovery | `geminiClient.listGeminiModels` (`x-goog-api-key`, paginated, `generateContent` only) and `groqClient.listGroqModels`; `aiService.listProviderModels` caches per key digest for 10 minutes and shares one in-flight listing. |
| Automatic fallback both ways | `aiService.analyzeJournal` iterates `configuredProviderIds(bundle)` in priority order (Gemini first by default), tries the next provider on any recoverable failure, and reports each failed attempt in `outcome.providerErrors`. |
| Both fail → complete deterministic report | `aiCore.buildDeterministicReport(analysis, buildEvidenceManifest(analysis))` produces a schema-valid `AiReport` from the local engine alone. `outcome.available === true`, `outcome.deterministic === true`, `errorCode === "all_providers_failed"`. |
| AI never overrides local calculations | Every verified field of an AI evidence row is overwritten from the manifest; the deterministic report and the AI report cite identical values. |
| No backend / Worker / serverless AI | Unchanged: the only network calls are to `generativelanguage.googleapis.com` and `api.groq.com` from the browser. `wrangler.toml` still holds no AI secret. |
| No artificial session limit | Per-request deadlines only (5s–240s, clamped by `resolveAiTimeoutMs`). |
| No endless retry | 3 transient attempts per provider, one 413 re-plan, one schema downgrade, at most two providers. |
| No duplicate concurrent requests | `inFlight` map keyed by `feature + service version + payload version + provider set + requested model + dataset fingerprint`; the second caller joins and is flagged `deduplicated`. |
| No oversized prompt | Measured budget, fixed shrink ladder, chunk-then-synthesize for large journals, provider-specific allowance (Groq's learned TPM vs Gemini's own `GEMINI_TOKEN_POLICY`). |
| No rejected report for one bad optional insight | `sanitizeAiReport` repairs or drops at claim granularity and discloses every repair in `outcome.repairs` (rendered under the report). |

### Files changed

* `shared/aiCore.ts` — Gemini model helpers, `groundedNumberSet` / `textIsGrounded`,
  `sanitizeAiReport` (repair-first validation), `reportIsEmpty`,
  `deterministicExecutiveSummary`, `buildDeterministicReport`.
* `shared/aiBudget.ts` — `GEMINI_TOKEN_POLICY`, `getGeminiRequestPolicy`,
  `getProviderRequestPolicy` (provider-agnostic budget selection).
* `client/src/lib/ai/geminiClient.ts` **(new)** — `listGeminiModels`,
  `toGeminiJsonSchema` (inlines `$ref`, drops unsupported keywords, maps
  `["number","null"]` → `nullable`), `requestGeminiStructuredCompletion`,
  `classifyGeminiError`.
* `client/src/lib/ai/aiStorage.ts` — dual-provider record, legacy migration,
  per-provider save/update/clear/priority, masked per-provider views.
* `client/src/lib/ai/aiTypes.ts` — per-provider settings view, `all_providers_failed`.
* `client/src/lib/ai/aiService.ts` — provider routing with fallback, dedupe,
  repair-first validation, deterministic safety net, provider-neutral copy.
* `client/src/components/UserAiProviderSettings.tsx`, `client/src/ai-providers.css`
  **(new)**, `client/src/components/AnalysisDashboard.tsx`,
  `client/src/pages/GoldJournal.tsx` (privacy notice), `client/src/main.tsx`.
* `README.md`, `wrangler.toml`, `wrangler.staging.toml` — documentation.

### Tests changed or added

* `client/src/lib/ai/geminiClient.test.ts` **(new, 14 tests)** — header-only key
  transport, schema projection, status-code mapping, one-shot schema downgrade,
  blocked/truncated/empty/timeout/cancel/offline, model discovery filtering.
* `client/src/lib/ai/aiService.test.ts` — new `dual-provider routing` suite
  (Gemini-first, fallback both ways, both-fail deterministic report, single
  provider isolation, cross-provider model protection, deterministic builder),
  claim-repair test, "never rejects the whole report" test, thin-answer test, and
  updated expectations where a failed AI request now yields the deterministic report.
* `client/src/components/UserAiProviderSettings.test.ts`,
  `client/src/pages/GoldJournal.mentorPrivacy.test.ts` — updated for two providers.

---

## 5. Verification

| Gate | Result |
| --- | --- |
| `pnpm exec tsc --noEmit` | Passed |
| `pnpm exec vitest run` | **113 files passed** (1 skipped), **889 tests passed** (2 skipped) |

## 6. Remaining limitations

* `client/src/pages/GoldJournal.tsx` is larger than the editing window available
  in this session, so three strings inside `MentorView` still name Groq
  specifically ("This browser is calling Groq directly…", "Pick an available Groq
  model", and the not-configured empty state). They are cosmetic: the mentor
  view already renders the deterministic report when every provider fails, and
  the privacy notice (`MENTOR_LOCAL_KEY_NOTICE`) names both providers.
* Gemini's free tier is metered per request rather than per token, so
  `GEMINI_TOKEN_POLICY.assumedAllowanceTokens` is this app's own prompt ceiling,
  not a vendor limit; `AI_TOKEN_POLICY.inputCeilingTokens` still bounds the
  prompt at 12,000 estimated tokens.
