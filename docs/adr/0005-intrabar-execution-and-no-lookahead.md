# 0005 — Intrabar execution model and the no-lookahead invariant

- Status: Accepted
- Date: 2026-08-25

## Context

An OHLCV bar records four prices and hides the path between them. When a stop and a target both
sit inside one bar's range, which one filled first is unknowable from the bar alone. Backtesters
that quietly pick the favourable branch are the reason backtests do not survive contact with a
live account.

## Decision

### 1. Order timing

An order submitted while processing the bar that closes at `T` gets `activeFrom = T + latency`,
and the matcher only considers it against market data whose interval ends strictly after
`activeFrom`. It can never fill against the bar the decision was made on.

### 2. Sub-bar latency is reported, not invented

In bar mode, latency smaller than one bar cannot be honoured: the engine cannot know where inside
the bar the order became active. Latency spanning whole bars is honoured exactly; sub-bar latency
is ignored and counted in `stats.subBarLatencyIgnored`. In tick mode latency is exact. Fabricating
a fill price for a sub-bar activation would be inventing precision the data does not contain.

### 3. Ambiguity is a first-class output

When more than one of an account's resting orders could have filled inside the same bar, the
engine applies an explicit `IntrabarPolicy` and increments `stats.ambiguousBars`.

- `pessimistic` (default) — the least favourable candidate fills first.
- `optimistic` — the most favourable fills first. Useful only as an upper bound.
- `ohlc-path` — assume the path open to low to high to close on an up bar, and open to high to low
  to close on a down bar.

The report prints the ambiguous-bar count and its share of total trades. A run with 40% ambiguous
trades is a run whose numbers mean nothing, and the reader is told so.

### 4. Fills are delivered inside the bar

When a resting order fills, `onFill` runs immediately, before the next candidate order is matched.
That is how a live account behaves, and it lets a strategy cancel the opposite leg of a bracket in
the same bar.

### 5. Matching happens before the strategy sees the bar

Order of operations per bar: drain scheduler, match resting orders, update indicators, call
`onBar`, mark to market.

## Alternatives considered

- **Fill everything at the bar close.** Trivially safe, wildly pessimistic, and it makes limit
  orders meaningless.
- **Fill at the mid of the range.** Invents a price that never traded.
- **Require tick data for anything with a stop.** Correct, and unusable for the 95% of research
  that starts from candles. Instead: allow bars, quantify the doubt.

## Consequences

- Two runs of the same strategy under different policies bracket the true result; the spread
  between them is itself a useful statistic.
- `stats.ambiguousBars` must be plumbed from the matcher all the way into the report.
