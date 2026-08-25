# 0012 — Metric conventions, and reporting nothing rather than something

- Status: Accepted
- Date: 2026-08-25

## Context

Every ratio in performance reporting has more than one definition in circulation. Sharpe with or
without a risk-free rate, sample or population deviation; Sortino divided by all periods or only
the losing ones; profit factor on gross or on net trade PnL; drawdown by depth or by duration.
A number whose definition is unstated is a number nobody can check, and two tools disagreeing by
30% on the same trade list is the normal case rather than the exception.

## Decision

**Each metric states its convention where it is computed.** The choices:

- **Sharpe** uses the _sample_ standard deviation of per-bar excess returns, annualised by the
  square root of the inferred bars per year. The risk-free rate defaults to zero and is converted
  to a per-bar rate before subtraction, not after.
- **Sortino** divides by downside deviation measured over _all_ periods, which is Sortino's own
  definition. The other convention — dividing by the count of losing periods — makes the ratio look
  better the fewer losses a strategy has, which is backwards.
- **Profit factor, gross profit and gross loss** are measured _after_ commission, the same measure
  the trades were classified by. A trade that made money before fees and lost after is a loss here,
  because that is what it was.
- **Cost share** divides commission by the _pre-cost_ trade PnL. Dividing by the net result would
  claim costs were 260% of a number costs had already been subtracted from — which the first real
  run did, before this was fixed.
- **Drawdown** reports depth and duration separately, and the deepest episode separately from the
  longest, because they are usually different episodes. A drawdown still open when the data ends is
  reported as unrecovered rather than as recovered on the last bar.
- **Bars per year** is inferred from the _median_ spacing of the equity curve. The mean would let a
  market's overnight gaps decide the answer; an exchange that closes should pass the number
  explicitly.

**A metric that cannot be computed reports `null`.** A profit factor with no losses, a Sharpe from
one bar, a CAGR over a zero-length run: each is `null`, never `Infinity`, `NaN`, or a comforting
zero. Zero is a result. Nothing is not.

**Derived floats are rounded to twelve significant digits before serialisation.** That is what makes
ADR-0006's "compared at a documented tolerance" a mechanism instead of a promise: two runs of the
same configuration produce byte-identical metrics JSON on any machine, even though `Math.pow` is
not specified to the last bit.

**Money never becomes a float.** Net profit, drawdown depth, expectancy and every per-trade figure
stay fixed-point integers from the ledger and are serialised as decimal strings.

## Alternatives considered

- **Matching a particular platform's numbers.** Tempting for comparability, and it would mean
  inheriting undocumented choices — including the ones that flatter.
- **Reporting zero for undefined metrics.** Simpler types, and it hides the difference between "no
  losses" and "no edge".
- **A configurable convention per metric.** Every convention becomes a flag, and every reported
  number needs its flags attached to be meaningful.

## Consequences

- Numbers here will differ from other tools. The definitions are in the source next to the
  arithmetic, so any difference can be traced rather than argued about.
- The `null` handling propagates into the types: `sharpe` is `number | null` everywhere, and
  callers have to decide what to print.
