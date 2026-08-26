# 0019 — A short run does not get an annual figure

- Status: Accepted
- Date: 2026-08-26
- Extends: [0012](0012-metric-conventions.md)

## Context

ADR-0012 says a metric that cannot be computed reports `null` rather than `Infinity`, `NaN` or a
comforting zero. That covers arithmetic that has no answer — a profit factor with no losses, a
Sharpe from a single bar.

It does not cover the case where the arithmetic has an answer and the answer means nothing. The
first real paper session this repository ran lasted nineteen seconds and reported a **CAGR of
-92%**. Nothing in that calculation is wrong: equity fell slightly, nineteen seconds is 1/1,600,000
of a year, and compounding the loss over that many periods produces −92%. The number is arithmetic
about the clock rather than a statement about the strategy, and it was printed in the same weight as
net profit.

A paper session's report reuses the backtest metrics unchanged, which is the right default — one
kernel, one metric set, one report — so the fix belongs in the metrics rather than in a separate
"live" variant.

## Decision

Annualised metrics are withheld when the run cannot support them, and the run says so.

Two rules, because the two families fail for different reasons:

- **CAGR, and Calmar through it, need a span.** They raise a total return to the power of
  `1 / years`. Under `MIN_DAYS_TO_ANNUALISE` (30 days) of observed span, both report `null`.
- **Sharpe, Sortino and volatility need observations.** They scale a sample's dispersion by
  `sqrt(periodsPerYear)`. Under `MIN_PERIODS_TO_ANNUALISE` (30) return periods, all three report
  `null`, together, so a reader never sees a Sharpe beside a missing volatility.

Both thresholds are exported constants, and both are conventions rather than theorems — which is
exactly why they are named and stated rather than buried in a comparison.

Everything that describes the window as it was observed is untouched: net profit, total return,
maximum drawdown and its duration, every trade statistic, and every cost figure. None of them
extrapolate.

When either rule bites, `computeMetrics` appends a note to the run's warnings saying which figures
were withheld, what the run actually covered, and that the observed figures are unaffected. The
warnings already print above the numbers in the terminal, in the HTML report and on the site, so the
reason arrives before the `n/a`.

## Alternatives considered

- **Leave it.** The number is correctly computed, and a reader who knows what CAGR is will discount
  it. That is the argument every backtester makes for every flattering default in this repository's
  first paragraph, and a −92% CAGR on a report is precisely the kind of figure that gets screenshotted
  without its context.
- **A separate metric set for live sessions.** Two code paths that must agree, and the same problem
  the other way round: a nineteen-second _backtest_ has the same defect and would keep printing it.
  The defect belongs to the window, not to the mode.
- **One threshold for everything.** Simpler to state and wrong in both directions. Thirty
  observations spread over a year is a fine sample for a CAGR and a poor one for a Sharpe; two
  points a year apart state an exact annual return and no dispersion at all.
- **Scale the confidence rather than withhold the number** — print a Sharpe with a standard error.
  More informative and more work to read, and it still puts a number where the honest answer is that
  there is not one. Worth revisiting if the metric set ever grows confidence intervals generally.
- **Refuse to produce a report at all below the thresholds.** The trade list, the cost breakdown and
  the drawdown of a short session are all real and useful. Only the extrapolations are not.

## Consequences

- A run shorter than 30 days prints `n/a` for CAGR and Calmar; one with fewer than 30 return
  periods prints `n/a` for Sharpe, Sortino and volatility. Both say why, above the numbers.
- The committed example is unaffected — 8,760 hourly bars over a year clear both thresholds — and
  `out/metrics.json` is byte-identical across this change, which the example run verifies.
- The demo's daily timeframe on a one-year tape produces 365 periods and stays above both. A user
  who narrows a run far enough will see the rule fire, which is the point.
- The thresholds are part of the metric contract now. Moving them changes published numbers, so
  they move by amending this ADR.
