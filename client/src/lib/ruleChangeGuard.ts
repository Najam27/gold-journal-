/**
 * 30-trade rule-change guard — pure evaluation logic.
 *
 * Trading rationale: the most common way new traders sabotage themselves is
 * changing their rules after a handful of trades — 10 trades is noise, not a
 * sample. A rule set needs roughly 30 closed trades before its edge (or lack
 * of one) is measurable, so when the trader edits their plan's rules this
 * module counts how many trades were logged under the *current* rule set and
 * warns when the sample is too small to justify a change.
 *
 * Deliberate choices, documented so future callers do not "fix" them:
 * - Rule identity is the rule's `id`, not its label. Same id + different
 *   label (after trimming whitespace) = renamed. A case-only change still
 *   counts as renamed (case-sensitive compare): labels surface in reports and
 *   plan PDFs, so silently "fixing" casing changes what the trader sees.
 * - An empty `previousRules` means this is the first plan ever — rule
 *   *creation*, not a change — so `rulesChanged` is false no matter what the
 *   new rules contain.
 * - `tradesOnCurrentRules` counts non-OPEN trades with a tradeDate strictly
 *   after `previousPlanDate` (compared as PKT calendar-day keys). Trades on
 *   the plan-change day itself belong to the old regime — the trader may have
 *   planned them before editing.
 * - Only explicitly OPEN trades are excluded from the count; a missing result
 *   is treated as a logged (closed-enough) trade so draft/import quirks do
 *   not silently shrink the sample.
 */

import { getPktDateInput } from "@/lib/gold";

export const RULE_CHANGE_MIN_TRADES = 30;

export interface GuardRule {
  id: string;
  label: string;
}

export interface RuleChangeCheck {
  rulesChanged: boolean;
  added: string[];
  removed: string[];
  renamed: Array<{ from: string; to: string }>;
  tradesOnCurrentRules: number; // CLOSED trades with tradeDate > previousPlanDate
  remaining: number; // max(0, 30 - tradesOnCurrentRules)
  referenceDate: string | null; // PKT YYYY-MM-DD of previousPlanDate
  shouldWarn: boolean; // rulesChanged && tradesOnCurrentRules < 30
  message: string;
}

function normalizeLabel(label: string | null | undefined): string {
  return (label ?? "").trim();
}

function isOpenTrade(result: string | null | undefined): boolean {
  return String(result ?? "").toUpperCase() === "OPEN";
}

function tradeWord(count: number): string {
  return count === 1 ? "trade" : "trades";
}

export function checkRuleChange(opts: {
  previousRules: GuardRule[];
  newRules: GuardRule[];
  previousPlanDate: string | number | Date | null;
  trades: Array<{ tradeDate: string | number | Date; result?: string | null }>;
}): RuleChangeCheck {
  const { previousRules, newRules, previousPlanDate, trades } = opts;

  const added: string[] = [];
  const removed: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];

  // First plan ever: this is rule creation, not a rule change.
  const rulesChanged =
    previousRules.length > 0 &&
    (() => {
      const previousById = new Map(previousRules.map((rule) => [rule.id, rule]));
      const newById = new Map(newRules.map((rule) => [rule.id, rule]));

      for (const rule of newRules) {
        const previous = previousById.get(rule.id);
        if (!previous) {
          added.push(normalizeLabel(rule.label) || rule.id);
        } else if (normalizeLabel(previous.label) !== normalizeLabel(rule.label)) {
          renamed.push({ from: previous.label, to: rule.label });
        }
      }
      for (const rule of previousRules) {
        if (!newById.has(rule.id)) removed.push(normalizeLabel(rule.label) || rule.id);
      }
      return added.length > 0 || removed.length > 0 || renamed.length > 0;
    })();

  let tradesOnCurrentRules = 0;
  let referenceDate: string | null = null;
  if (previousPlanDate !== null && previousPlanDate !== undefined) {
    const planDay = getPktDateInput(previousPlanDate);
    if (planDay) {
      referenceDate = planDay;
      for (const trade of trades) {
        if (isOpenTrade(trade.result)) continue;
        const tradeDay = getPktDateInput(trade.tradeDate);
        // Strictly after: trades planned on the change day itself belong to the old rules.
        if (tradeDay && tradeDay > planDay) tradesOnCurrentRules += 1;
      }
    }
  }

  const remaining = Math.max(0, RULE_CHANGE_MIN_TRADES - tradesOnCurrentRules);
  const shouldWarn = rulesChanged && tradesOnCurrentRules < RULE_CHANGE_MIN_TRADES;

  let message = "";
  if (shouldWarn) {
    message =
      `You've logged ${tradesOnCurrentRules} ${tradeWord(tradesOnCurrentRules)} on this rule — ` +
      `${remaining} more before changing it.`;
  } else if (rulesChanged) {
    message = "30+ trades logged — you have a real sample; change thoughtfully.";
  }

  return {
    rulesChanged,
    added,
    removed,
    renamed,
    tradesOnCurrentRules,
    remaining,
    referenceDate,
    shouldWarn,
    message,
  };
}
