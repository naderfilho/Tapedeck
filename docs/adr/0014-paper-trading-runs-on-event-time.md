# 0014 — Paper trading runs on event time, and says how far behind it is

- Status: Accepted
- Date: 2026-08-25
- Amends: [ADR-0003](0003-synchronous-deterministic-kernel.md)

## Context

ADR-0003 said that exactly two things differ between a backtest and a live session: which `Clock`
answers `now()`, and who fills the event queue. Building phase 4 showed that the first half of that
sentence was wrong, and that getting it right matters more than the sentence did.

A live feed arrives with the venue's own timestamps. Our wall clock is a different clock, running
on a different machine, ahead or behind by an unknown amount. If `now()` answered with wall time
while the broker matched against venue timestamps, then every order's `activeFrom` — the instant
its latency has elapsed and it may match — would be offset by the skew between the two. A machine
two seconds fast would fill differently from a machine two seconds slow, on identical data.

Worse, it would make the phase-4 acceptance test impossible to write. The claim being proved is
that the same event sequence produces the same fills through the live path and the backtest path.
A kernel reading the wall clock produces a different answer every time it is run.

## Decision

**The kernel runs on event time in both modes.** The engine's clock advances to the timestamp of
the event being processed, live exactly as in a backtest. `LiveClock` still exists and is still the
only place in the core allowed to read the host clock, but it is used to _measure_, not to drive.

Three consequences follow, and each is a feature rather than a workaround:

**Lag is reported, not applied.** `LiveSession` records wall time minus event time at the moment
each event finishes processing, and reports the worst value with the results. That number is venue
delay plus network plus queue plus this process, and there is no way to separate the venue's share
from a single side of the connection — so it is reported as one number with that caveat attached,
rather than decomposed into parts we would be inventing.

**A quiet market gets heartbeats.** With nothing but market events driving the clock, an order
whose latency elapsed at 10:00:01 would stay pending until the next print, which on an illiquid
instrument could be minutes. The session emits a heartbeat on a timer; the engine drains its
scheduler and advances to it. A heartbeat carries the wall-clock reading that produced it, so a
recorded event sequence replays identically — the nondeterminism is captured at the edge and
becomes data.

**Backpressure is visible.** The queue has a depth and a cap. At the cap the session refuses
events and counts the refusals; it never drops the oldest, never drops the newest, and never
reorders. A paper session that quietly skipped part of the tape produces fills that cannot be
traced to any market that existed.

**The stream is push, not pull.** `MarketStream` takes a handler and calls it; there is no
`AsyncIterable` of market events. An async iterator looks tidier and hides the only question that
matters live — what happens when the strategy is slower than the market — inside a buffer nobody
can see.

## What a restart restores, and what it does not

A session resumed from a `PaperState` gets the account back: cash, the cost basis of every open
position, realised PnL, the resting orders, and the order and fill counters, so the audit trail
continues rather than overwriting itself.

It does not get the strategy's memory back. A field in a closure is gone, and `bar.index` restarts
at zero because it counts _this run's_ bars. This was found by a test rather than reasoned out: the
first equivalence test between an uninterrupted session and a resumed one failed twice, once on a
closure variable and once on `bar.index`. Serialising a strategy's state would mean either a
serialisation contract every strategy has to implement or a structured-clone of arbitrary
closures — the first is a tax on every strategy for a feature most do not need, the second does not
work. So the limitation is stated instead: in `Strategy.onInit`, in the warnings a resumed session
prints, and in a test that asserts the counter really does reset.

## Alternatives considered

- **Wall clock drives the kernel.** The literal reading of ADR-0003. Rejected above: clock skew
  becomes execution logic, and the equivalence test cannot exist.
- **Blend the two — event time, corrected by measured skew.** Estimating skew from one side of a
  connection means estimating the network delay it is confounded with. A number that is a guess
  should not be silently multiplied into fills.
- **Drop the oldest event when the queue is full.** Standard for telemetry, wrong for a tape. The
  fills that follow reference a market with a hole in it, and nothing downstream can tell.
- **Replay the fill log to rebuild state.** Rejected in favour of the snapshot: replaying means
  re-deriving cash from commissions and hoping the derivation matches what was charged. The fill
  log stays as the audit trail, and fills recorded after the last snapshot are counted and
  reported — that count is the width of the window a crash can lose.

## Consequences

- A paper session and a backtest over the same events produce identical fills, asserted as an
  equality in `packages/core/test/live.test.ts` over property-generated series, and end to end on a
  real year of BTCUSDT in `packages/data/test/binance-stream.test.ts`.
- The live path's timestamps must match the historical provider's to the microsecond, including
  the `closeTs = (T + 1)ms` convention. The end-to-end test is what keeps them from drifting.
- `Engine.advanceTo` is public. It fires due timers and cannot produce a fill, because matching is
  driven by market events and a heartbeat is not one.
- Reported lag depends on the venue's clock agreeing with ours. It is a diagnostic, not a
  measurement of latency, and it is worded that way where it is printed.
