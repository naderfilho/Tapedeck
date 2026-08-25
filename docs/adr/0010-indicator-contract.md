# 0010 — The indicator contract

- Status: Accepted
- Date: 2026-08-25

## Context

Indicators are where a backtesting engine usually starts leaking. They are the code most likely to
recompute a window, to be updated in the wrong order, to be read one bar stale, or to disagree with
the chart the strategy author was looking at when they had the idea.

## Decision

**One method, one sample, one value.** `update(sample)` takes exactly one input and returns the new
value. There is no method that takes a series, so there is nothing to accidentally call inside a
loop. `ready` and `value` are the only other members.

**The core declares the contract; the library implements it.** `@tapedeck/core` owns the
`Indicator` interface and knows about no indicator in particular, so a strategy's own private
calculation is a first-class citizen and the dependency arrow keeps pointing inward (ADR-0001).

**The engine owns the update.** `ctx.use(indicator)` registers it; the engine updates it once per
bar, after resting orders have matched and before `onBar`. A strategy therefore cannot forget to
update one, cannot update one twice, and cannot read a value belonging to a different bar. What it
gets back is a frozen handle with no `update` method on it.

**Classes take numbers, factories take bars.** `new Ema(20)` smooths any number stream, which is
what makes a MACD expressible as an EMA of the difference of two EMAs. `ema({ period: 20 })`
returns a bar-level indicator reading the close. One adapter, `fromSource`, connects the two.

**Values stay in the instrument's fixed-point price scale.** An SMA of `BTCUSDT` is a number of
cents, like the prices it consumed. Crossing back into the ledger means one call to `roundToTick`,
and the boundary is visible in the code rather than implied.

**Correctness is a property test, not a table.** For any random series, the incremental result must
equal a deliberately naive implementation that recomputes from scratch on every bar. A table of
expected values only proves that the author and the implementation agree.

## Alternatives considered

- **Indicators as pure functions over an array.** Familiar, and O(n) per bar. It is the design
  that makes a million-bar backtest take a minute instead of a second, and it cannot run live at
  all, because a live session does not have the array.
- **Strategies updating their own indicators.** One less concept, and one more way to read a stale
  value. The bug it invites — updating after the decision rather than before — produces results
  that look plausible.
- **A single `update(bar)` signature for everything.** Simpler contract, but then a MACD cannot
  compose EMAs without inventing a fake bar.

## Consequences

- Two numerical decisions in `primitives.ts` needed real work, and both were found by property
  tests rather than by reading the code: rolling accumulators are resynchronised so error cannot
  grow without bound, and variance is computed against a shift so it does not cancel catastrophically
  on large prices with a small spread. Those are documented at the point of use.
- Indicators do not see ticks. Tick-driven indicators are a separate contract and can be added
  without changing this one.
