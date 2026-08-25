# 0003 — A synchronous kernel for both backtest and live

- Status: Accepted
- Date: 2026-08-25

## Context

The central architectural claim of this project is that a strategy runs unchanged in backtest and
in paper trading. That only holds if both modes share the same dispatch code. Backtest data comes
from disk (asynchronous I/O), live data comes from a WebSocket (asynchronous events), but the
engine that consumes them must be one implementation.

## Decision

**The kernel is synchronous. Strategy lifecycle hooks return `void`, never `Promise<void>`.**

Asynchrony is confined to the edges:

- `DataProvider` is async and chunked. The runner does `for await (const chunk of provider.bars())`
  — one `await` per chunk of tens of thousands of bars, not per bar — and hands each chunk to the
  engine as a synchronous columnar buffer.
- In live mode the WebSocket handler does nothing but enqueue the event and call `engine.drain()`,
  which is the same synchronous routine the backtest runs.

Only two things differ between the modes: which `Clock` answers `now()` (`SimulatedClock` advances
to the next event timestamp, `LiveClock` reads the wall clock) and who fills the event queue.

## Alternatives considered

- **Async `onBar`.** Costs a microtask per bar: 1-3 microseconds of overhead alone, capping
  throughput near 300-500k bars/s before any strategy logic runs. Worse, event delivery order would
  depend on the event-loop scheduler, which destroys reproducibility — the property this project
  exists to demonstrate.
- **Worker threads for the hot loop.** Adds serialization cost at the boundary and does not remove
  the ordering problem. Parallelism belongs at the level of _runs_ (parameter sweeps), not bars.

## Consequences

- A strategy cannot perform I/O inside a callback. Strategies needing external input use a
  side channel that does the I/O outside the kernel and injects the result as a future event,
  which keeps event ordering explicit and replayable.
- Backpressure in live mode is the queue's problem, not the strategy's: a slow strategy grows the
  queue and the engine reports the lag rather than silently reordering.
