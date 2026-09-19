# Plan & Execution + Psychology renewal — workflow and behavioural-system refactor

Date: 2026-09-19
Scope: `client/src/components/PlanExecutionEditor.tsx`, `client/src/components/TraderDevelopmentPanel.tsx`, `client/src/lib/planWorkflow.ts` (new), `client/src/lib/psychology.ts`, `shared/psychologyEngine.ts`, `server/planReviewRouter.ts` (new), `supabase/migrations/0026_plan_copy_and_behavioural_loop.sql` (new).

## What was wrong

* Plan & Execution was one long form: market context, scenarios, risk, thesis, twenty scoring
  fields, psychological scores, triggers, review prose, and ratings all visible at once, in one
  column, before anything could be saved.
* A daily plan is usually "yesterday's plan with new market conditions". There was no way to start
  from yesterday's plan, so every session was retyped from scratch.
* The psychology check-in stored state (emotion, energy, focus, confidence, stress) but had no
  action loop: no single objective per session, no verdict on whether it held, no trigger record,
  and therefore no behavioural history to analyse.
* The Psychology page opened on a wall of scores instead of the four questions a trader actually
  asks: what is improving, what repeats, which triggers sit beside rule breaks, what do I focus on
  next.

## What changed

### Plan & Execution is now a staged workflow

1. **Session status** — NOT STARTED → PLANNED → IN PROGRESS → REVIEW REQUIRED → REVIEWED, derived
   from the saved plan and the day's trades (`planSessionStatus`). No invented states.
2. **Copy from previous day / Copy from date** — a prominent button plus a saved-date selector.
   The copy builds an editable *draft*: planning fields carry over, every finished-session field
   resets, nothing is written until `Save plan`, and the source plan is never mutated.
3. **Quick plan** — bias, session focus, key levels, event risk, long/short scenarios, no-trade
   condition, loss limit, max trades, sizing rule, the applicable rules checklist, and ONE
   behavioural objective. `More planning details` holds market context, bias invalidation, session
   thesis, the psychological risk note, and confidence; `Optional ratings and notes` holds the
   execution score, session rating, and execution narrative.
4. **Smart copy** — `Based on Sep 18` plus a subtle changed/unchanged list for the copied fields.
5. **Plan vs execution** — planned limits (loss limit, max trades, sessions, rules applied) against
   actual behaviour (trades, risk used, unplanned entries, violations), the adherence percentage,
   and only the deviations that matter. Built from the same behavioural engine the rest of the
   journal uses.
6. **Prepare tomorrow** — creates the next day's draft from today's structure and promotes today's
   *tomorrow focus* into tomorrow's behavioural objective. No measurement or review value moves.
7. **Plan history** — search over the stored plan object, a month grid, and per-day rows showing
   date, bias, risk limit, max trades, behavioural focus, and review status, each with
   `Open` and `Copy to today`.

### Psychology is now a behavioural-performance loop

* **Before trading (10–20 s):** emotional state, energy, focus, stress, and exactly ONE behavioural
  objective, with readiness shown as Ready / Caution / High risk. Readiness is guidance and never
  blocks a trade.
* **After the session:** did I follow the plan, did the objective hold (Yes / Partially / No), what
  went well, what went wrong, biggest deviation, one lesson, tomorrow's focus, the trigger
  multi-select ("what triggered me today?"), what was done because of it, and the biggest
  psychological mistake. Only the ratings stay optional.
* **Behavioural summary first:** the Psychology page now opens with What is improving, What is
  repeating, Triggers beside rule breaks, and the current objective — each from saved data only,
  with `View detailed analytics` keeping every existing calculation (discipline score and its
  weights, focus, streaks, weekly psychology, outcome vs process, identity consistency).
* **Process is not P&L:** the GOOD WIN / BAD WIN / GOOD LOSS / BAD LOSS split and the behavioural
  P&L buckets are unchanged, and the review copy states explicitly that a profitable trade can
  break the plan and a losing trade can be executed correctly.
* **Language stays behavioural:** emotional state, behavioural trigger, discipline, focus, rule
  adherence. The only causal claim is deliberately neutral — "Potential behavioural deviation
  against today's objective" — and a trigger is only linked to a rule break when the behaviour it
  names was itself flagged that session.
* **Trade Log link:** the trade dialog now shows the day's behavioural objective next to the plan
  link, and adds the neutral deviation line when a trade previews as off-process.

## Data model

Migration `0026_plan_copy_and_behavioural_loop.sql` adds six nullable columns to `gj_daily_plans`
(`copiedFromPlanId`, `copiedFromPlanDate`, `psychologyTriggers`, `primaryPsychologyTrigger`,
`behavioralObjectiveStatus`, `postSessionBehavioralReview`) with checks that accept NULL, plus the
matching Drizzle metadata and `pnpm schema:audit` assertions. No column is dropped, renamed, or
back-filled; every field the previous editor wrote is still read, written, and displayed.

The behavioural close-out is persisted by `plans.save`'s sibling procedure `planReview.save` — an
ownership-checked, idempotent upsert on the same `(userId, accountId, planDate)` row. If migration
0026 has not been applied yet, the planning half of the save still succeeds and the response says
the behavioural close-out was not stored instead of failing the whole save.

Field behaviour on copy is asserted in code (`PLAN_COPY_FIELDS`, `PLAN_RESET_FIELDS`) so it cannot
drift silently.

## Verification

* `pnpm check` — clean.
* `pnpm schema:audit` — clean (migration order and `planCopyAndBehaviouralLoopMigrationHardened`).
* `pnpm test` — full suite green, including new coverage:
  * `client/src/lib/planWorkflow.test.ts` (27) — copy/reset contract, source never mutated, editable
    copy, tomorrow promotion, previous-plan selection, Pakistan-time day boundaries, smart-copy
    diff, the five session states, plan vs execution (planned/actual, unplanned, violations, risk
    limit, max trades, adherence), legacy-plan loading.
  * `client/src/pages/PlanView.test.tsx` (13) — copy without a database write, copy from date,
    saved plan update, save failure keeps the entry, status, plan-vs-execution read, progressive
    disclosure, behavioural loop save.
  * `shared/psychologyEngine.test.ts` (+9) — trigger parsing across serialisations, objective
    verdicts, review detection, feedback summary, "no data instead of a score", P&L untouched.
  * `client/src/lib/psychology.test.ts` (5) — adapter summary from real sessions, config merge,
    legacy review stays empty.
  * `server/planReviewRouter.test.ts` (6) — owner-scoped write, NULL for unanswered review,
    rejected cross-account write, missing-migration fallback, genuine failures still throw.

## Deploy step

Apply `supabase/migrations/0026_plan_copy_and_behavioural_loop.sql` to the Supabase project, then
deploy. The migration is additive and safe to run on a live database.
