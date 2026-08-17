# Gold Journal Trader-Control Library Research — 17 August 2026

## Design Principle

The Goals library should **measure the trader’s own saved evidence** rather than diagnose psychology, prescribe a universal strategy, or create fictional trade data. Controls remain configurable thresholds and neutral prompts. The current journal can already measure closed-trade P&L, planned risk/reward, trade count, behavior tags, screenshots, strategy scope, and Plan & Execution reviews.

## Sources Reviewed

Investopedia describes risk management as balancing opportunity against loss, and highlights planning entries/exits, stop-losses, position risk, and objective criteria before emotions determine trade management.[1] A Daytrading community discussion repeatedly links FOMO, revenge, overtrading, oversizing, missed planning, loss limits, and post-trade journaling as connected forms of discipline failure rather than fully independent problems.[2]

A practitioner video on risk management and journaling reinforces sample-size review, risk definition, loss limits, and planned review, while distinguishing measures that need unavailable market data (such as maximum adverse excursion or product volatility) from journal-available fields.[3] Its most useful addition for Gold Journal is **not** a universal threshold; it is a reminder that the system should expose trader-owned patterns from an adequate saved sample rather than react to a few isolated outcomes.

> “Plan the trade and trade the plan.” — cited in Investopedia’s active-trader risk-management guidance.[1]

> “Trading journal. If you don’t know what you’re doing wrong, you can’t change it.” — community contributor in the reviewed Daytrading discussion.[2]

## Proposed Control Library

| Group | User-facing control | Existing journal evidence | Status model |
|---|---|---|---|
| Capital safety | Max daily loss; max weekly drawdown; loss-streak reset; daily trade cap | Closed-trade P&L and result | Existing threshold controls retained. |
| Unified behavior discipline | **Behavior breach ceiling** covering FOMO, revenge, overtrading, and oversizing together | Multi-tag `mistake` field on closed trades | Counts any trade tagged with one or more of the four behavior patterns once per trade, preventing double-counting. |
| Execution integrity | Rule-break ceiling; chart-evidence habit; pre-trade plan coverage | Rule-break tags, screenshot presence, same-day plan | New plan-coverage percentage measures whether the executed-trade date has a saved pre-session protocol, not whether the plan was “good.” |
| Risk quality | Risk-defined trade rate; planned R:R floor | Positive planned risk, planned risk/reward fields | New configurable percentage and average R:R controls. They do not infer broker stop placement. |
| Review consistency | Weekly review habit; process-quality floor; minimum closed-trade sample | Plan review record, `overallRating`, and closed-trade count | Existing weekly review retained; new process-quality and sample controls use saved data only. |
| Strategy integrity | Strategy compliance; A/A+ setup rate | Existing scoped fields and setup quality | Existing compliance retained; quality rate becomes a clear template rather than a claim about profitability. |

The new risk-quality, plan-coverage, and minimum-sample measures are included because they can be calculated directly from existing fields. No sleep, mood, broker leverage, stop-loss, position-size, price-excursion, or news-calendar data will be invented or implied.

## Implementation Decision

The old template choices **No FOMO entries**, **No revenge entries**, **No overtrades**, and **No oversizing** will be replaced in the control library by one **Behavior breach ceiling** template. It will count each closed trade carrying *any* of those four saved behavior tags exactly once, even when a trader applies multiple tags to the same trade. This preserves the detail in the trade record while giving the trader one control and one alert stream. Existing saved controls with the old metrics remain readable, editable, and calculated for backward compatibility; no goal rows are deleted or rewritten.

New templates will use only already stored data: **Risk-defined trade rate**, **Planned R:R floor**, **Pre-session plan coverage**, **Process-quality floor**, **Minimum closed-trade sample**, and **A/A+ setup rate**. They will stay configurable by threshold, review window, and notification preference. The goal table, generic alert persistence, account scoping, MT5 synchronization, and fixed UTC+5 period boundaries do not require a database migration because the current `metric` field stores a string and the goal engine is the canonical evaluator.

## References

[1]: [Investopedia — Risk Management Techniques for Active Traders](https://www.investopedia.com/articles/trading/09/risk-management.asp)

[2]: [Reddit r/Daytrading — What do you do to reduce overtrading, revenge trading and FOMO?](https://www.reddit.com/r/Daytrading/comments/1hzhx4y/what_do_you_do_to_reduce_overtrading_revenge/)

[3]: [Mr OrderFlow — Risk Management and Journaling To Increase Trading Profits](https://www.youtube.com/watch?v=x2OJNpulRik)
