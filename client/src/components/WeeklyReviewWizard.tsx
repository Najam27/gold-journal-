import React, { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarCheck, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { pktWeekRange, reviewableWeekOffset, summarizeWeek } from "@/lib/weeklyReview";
import { formatMoney } from "@/lib/gold";

interface ReviewTradeLike {
  tradeDate: string | number | Date;
  result?: string | null;
  pnl?: number | string | null;
  risk?: number | string | null;
  mistake?: string | null;
  planStatus?: string | null;
}

const STEPS = ["Numbers", "Best & worst", "Mistakes", "Lesson", "One rule"] as const;

function pct(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

/**
 * Guided weekly review ritual. Walks the trader through the reviewable week's
 * stats (PKT Monday–Sunday — the week ending today on Sundays, otherwise the
 * last completed week), biggest win/loss, top mistakes, the lesson, and one
 * rule for next week — then saves the review durably via weeklyReviews.save.
 * Fetches its own journal data, so it drops straight into the Analysis view.
 */
export function WeeklyReviewWizard({ accountId }: { accountId: number }) {
  const [step, setStep] = useState(0);
  const [lesson, setLesson] = useState("");
  const [ruleForNextWeek, setRuleForNextWeek] = useState("");
  const utils = trpc.useUtils();
  const saveReview = trpc.weeklyReviews.save.useMutation();

  const journal = trpc.journal.get.useQuery({ accountId }, { enabled: Boolean(accountId), refetchOnWindowFocus: false });
  const trades: ReviewTradeLike[] = (journal.data as { trades?: ReviewTradeLike[] } | undefined)?.trades ?? [];
  const plans: Array<{ planDate: string | number | Date }> = (journal.data as { dailyPlans?: Array<{ planDate: string | number | Date }> } | undefined)?.dailyPlans ?? [];

  const week = useMemo(() => {
    // On Sunday the week ending today is reviewable; otherwise show the last
    // completed week.
    const { start, end } = pktWeekRange(new Date(), reviewableWeekOffset());
    const summary = summarizeWeek(
      trades.map(trade => ({ ...trade, pnl: trade.pnl ?? null })),
      plans,
      start,
      end
    );
    return { start, end, summary };
  }, [trades, plans]);

  const { summary } = week;
  const saved = trpc.weeklyReviews.list.useQuery({ accountId, limit: 12 });

  const submit = async () => {
    try {
      await saveReview.mutateAsync({
        accountId,
        weekStart: week.start.getTime(),
        weekEnd: week.end.getTime(),
        statsSnapshot: summary as unknown as Record<string, unknown>,
        lesson: lesson.trim() || null,
        ruleForNextWeek: ruleForNextWeek.trim() || null,
      });
      await utils.weeklyReviews.list.invalidate({ accountId });
      toast.success("Weekly review saved. See you next Sunday.");
      setStep(0);
      setLesson("");
      setRuleForNextWeek("");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Could not save the review.");
    }
  };

  const lastRule = (saved.data?.[0] as { ruleForNextWeek?: string | null } | undefined)?.ruleForNextWeek ?? null;

  return (
    <section className="panel weekly-review-panel">
      <header>
        <span><CalendarCheck size={15} /> Weekly review</span>
        <small>{summary.weekLabel}</small>
      </header>

      <div className="review-steps">
        {STEPS.map((label, index) => (
          <button
            key={label}
            type="button"
            className={`review-step${index === step ? " active" : ""}${index < step ? " done" : ""}`}
            onClick={() => setStep(index)}
          >
            {index < step ? <CheckCircle2 size={13} /> : <span>{index + 1}</span>}
            {label}
          </button>
        ))}
      </div>

      {step === 0 && (
        <div className="review-body">
          <div className="review-stats">
            <div><span>Trades</span><strong>{summary.closedCount}</strong></div>
            <div><span>Net P&L</span><strong>{formatMoney(summary.netPnl)}</strong></div>
            <div><span>Win rate</span><strong>{pct(summary.winRate)}</strong></div>
            <div><span>Avg R</span><strong>{summary.avgR == null ? "—" : `${summary.avgR.toFixed(2)}R`}</strong></div>
            <div><span>Profit factor</span><strong>{summary.profitFactor == null ? "—" : summary.profitFactor.toFixed(2)}</strong></div>
            <div><span>Planned trades</span><strong>{pct(summary.plannedPct)}</strong></div>
          </div>
          <p className="review-note">{summary.closedCount === 0 ? "No closed trades this week — the numbers are empty, and that's data too." : `${summary.daysTraded} day${summary.daysTraded === 1 ? "" : "s"} traded, ${summary.plansLogged} plan${summary.plansLogged === 1 ? "" : "s"} logged.`}</p>
        </div>
      )}

      {step === 1 && (
        <div className="review-body">
          <div className="review-highlight">
            <span>Biggest win</span>
            <strong>{summary.biggestWin ? `${formatMoney(summary.biggestWin.pnl)} · ${summary.biggestWin.date}` : "—"}</strong>
          </div>
          <div className="review-highlight">
            <span>Biggest loss</span>
            <strong>{summary.biggestLoss ? `${formatMoney(summary.biggestLoss.pnl)} · ${summary.biggestLoss.date}` : "—"}</strong>
          </div>
          <p className="review-note">What did the best trade do right? What did the worst one do wrong? Name it out loud.</p>
        </div>
      )}

      {step === 2 && (
        <div className="review-body">
          {summary.topMistakes.length === 0 ? (
            <p className="review-note">No mistakes tagged this week. Either flawless execution — or under-tagged. Be honest about which.</p>
          ) : (
            <ul className="review-mistakes">
              {summary.topMistakes.map(item => (
                <li key={item.mistake}><span>{item.mistake}</span><strong>×{item.count}</strong></li>
              ))}
            </ul>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="review-body">
          <label className="review-field">
            <span>The one lesson from this week</span>
            <Textarea
              rows={4}
              value={lesson}
              onChange={event => setLesson(event.target.value)}
              placeholder="If you could only keep one insight from this week…"
            />
          </label>
        </div>
      )}

      {step === 4 && (
        <div className="review-body">
          {lastRule && (
            <p className="review-note">Last week's rule: <strong>{lastRule}</strong> — did you keep it?</p>
          )}
          <label className="review-field">
            <span>One rule for next week</span>
            <Textarea
              rows={3}
              value={ruleForNextWeek}
              onChange={event => setRuleForNextWeek(event.target.value)}
              placeholder="e.g. No trades in the first 15 minutes of London."
            />
          </label>
        </div>
      )}

      <div className="review-actions">
        <Button variant="outline" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
          <ArrowLeft size={14} /> Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button onClick={() => setStep(step + 1)}>
            Next <ArrowRight size={14} />
          </Button>
        ) : (
          <Button onClick={submit} disabled={saveReview.isPending}>
            {saveReview.isPending ? "Saving…" : "Complete review"}
          </Button>
        )}
      </div>
    </section>
  );
}
