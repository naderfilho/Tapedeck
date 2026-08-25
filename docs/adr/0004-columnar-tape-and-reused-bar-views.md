# 0004 — Columnar tape and reused bar views

- Status: Accepted
- Date: 2026-08-25

## Context

"Components communicate only through events" is the right _semantics_. Implemented literally, with
an `EventEmitter` and a freshly allocated event object per bar, it yields roughly 150-300k bars/s
on V8 and a garbage collector that never rests. The performance target is around 1M bars/s.

## Decision

The event bus is two mechanisms, not one.

1. **A deterministic min-heap** keyed by `(timestamp, seq)` for _scheduled_ events: order
   activation after latency, timers, live queue drains. This is where "everything is an event"
   literally holds, and it is what makes the simulated and wall clocks interchangeable.
2. **Static dispatch over columnar storage** for market data. Bars live in `Float64Array` columns
   (a double represents every integer up to 2^53 exactly, so fixed-point values survive intact and
   reads need no conversion). The engine walks a cursor and updates the fields of a single reused
   `BarView` object before each callback.

The aliasing hazard of a reused object is handled rather than ignored. When strict mode is on
(the default outside `NODE_ENV=production`, and always under test), the view handed to a strategy
is a **revocable Proxy**, revoked the moment the callback returns. Retaining the reference and
reading it later throws a `TypeError` at the exact line that did it, instead of silently reading a
future bar.

## Alternatives considered

- **A frozen object allocated per bar.** Bullet-proof API, roughly 2.5-3x slower, and
  `Object.freeze` in a hot loop costs more than the allocation itself. Kept available as
  `barViewMode: 'copy'` for users who prefer safety over speed.
- **A reused object with no guard.** Fastest, but a retained reference becomes a silent lookahead
  bug, the single worst failure mode a backtester can have.
- **Passing the raw arrays plus an index.** Fast and safe from aliasing, but a strategy could index
  forward and read the future. The point of the view is that indexing forward is not expressible.

## Consequences

- Strategies must not retain the bar object across callbacks. This is stated in the `Strategy`
  documentation and enforced by the strict-mode proxy in every test run.
- Development and test runs are measurably slower than production runs; the benchmark reports both
  numbers so the difference is never a surprise.
