# Behavioral AI Mentor Design Notes — 2026-08

## Purpose

Extend Gold Journal's account-scoped AI Mentor so it helps a trader review observable behavior patterns—such as tagged FOMO, revenge trading, overtrading, oversizing, post-loss risk changes, and plan/rule adherence—without offering clinical diagnosis, market signals, or claims not supported by saved journal data.

## Research findings and product implications

| Finding | Product implication |
| --- | --- |
| Trading psychology literature describes fear, greed, regret, overconfidence, loss aversion, and emotional reactions as influences on decision-making; these are not diagnoses. [1] | Use factual language such as “the saved tags and trade sequence are consistent with a possible post-loss escalation pattern,” rather than “you have revenge-trading addiction.” |
| A major loss can impair near-term discipline; structured cooling-off, written reflection, and predefined controls are practical non-clinical responses. [2] | Mentor experiments may propose a precommitted pause, written post-loss review, or reduced-risk test only as a measurable experiment—not a command or investment recommendation. |
| A 2025 systematic review warns against automatically applying a gambling/addiction framework to trading and emphasizes the need for accurate operationalization. [3] | Never label the trader as addicted, compulsive, pathological, or mentally ill. Surface an observable pattern and state the sample and data limitations. |
| A Daytrading community discussion repeatedly recommends tagging revenge trades, applying explicit session loss/trade limits, and pausing before a subsequent trade after loss. [4] | Convert user-tagged behavior and sequence evidence into a count, P&L comparison, and optional testable rule. Treat community ideas as practitioner input, not clinical evidence. |

## Evidence contract

The Mentor may use only account-owned journal fields and deterministic aggregates. It must provide the supporting sample, known missing fields, and confidence for every behavioral conclusion. The behavioral fields are inputs for review, not independent proof of a psychological condition.

The first implementation should focus on these non-clinical metrics:

1. Tagged behavior incidence and P&L: FOMO, revenge, overtrading, oversizing, rule violation, and any custom tags.
2. Outcome sequence: risk, trade count, and P&L after a WIN or LOSS, including whether the next-trade sample is insufficient.
3. Within-day concentration: count and P&L of trade clusters, explicitly framed as an overtrading signal only where an account has a configured trade-frequency rule or a clear sample comparison.
4. Plan and evidence coverage: whether saved trades contain a plan, risk, notes, screenshot, and selected context. Missing data limits conclusions.
5. Risk drift: compare risk after wins, losses, and during drawdown only when real risk amounts are present.

## Safety and privacy boundaries

- Do not diagnose mental health or addiction; do not use shaming, coercive, or absolutist language.
- Do not generate BUY/SELL directions, entries, exits, price targets, or promises of profitability.
- Do not send raw notes, screenshots, keys, tokens, or browser credentials to AI. Use compact, account-scoped aggregates only.
- When a loss pattern appears severe or distress is explicitly described, the product should encourage pausing trading and seeking an appropriate qualified professional or local support—not attempt therapy.

## References

[1] [Investopedia, “Trading Psychology: Definition, Examples, Importance in Investing”](https://www.investopedia.com/terms/t/trading-psychology.asp)

[2] [Charles Schwab, “Trading Psychology: Recovering From Big Losses”](https://www.schwab.com/learn/story/trading-psychology-recovering-from-big-losses)

[3] [Loscalzo, Rogier & Velotti, “Problematic trading: a Systematic Review of theoretical considerations,” *Frontiers in Psychiatry* (2025)](https://pmc.ncbi.nlm.nih.gov/articles/PMC12070191/)

[4] [r/Daytrading discussion, “How do you stop revenge trading?”](https://www.reddit.com/r/Daytrading/comments/1rjm7tw/how_do_you_stop_revenge_trading/)
