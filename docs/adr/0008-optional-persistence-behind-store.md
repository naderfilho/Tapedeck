# 0008 — Optional persistence behind a Store interface

- Status: Accepted
- Date: 2026-08-25

## Context

Three things want to be persisted: downloaded market data (expensive to refetch), backtest runs
(parameters, metrics, equity curve) and live paper-trading state (must survive a restart). None of
them may slow down or complicate the engine.

## Decision

`@tapedeck/core` declares a `Store` interface and **never imports an implementation**. A backtest
runs entirely in memory and writes once, at the end, if a store was injected. Paper trading writes
incrementally, because a crash there loses real state.

```text
Store
├── bars   BarCache          get/put by (venue, symbol, timeframe, range)
├── runs   RunRepository     params + metrics + equity curve + trades
└── paper  PaperRepository   orders, fills, positions; crash recoverable
```

`@tapedeck/store` provides the default `node:sqlite` implementation. `NullStore`, a no-op, is the
default so the engine never branches on whether a store exists.

## Alternatives considered

- **Persist inside the engine.** Couples the hot loop to I/O and makes the engine untestable
  without a filesystem.
- **Write the equity curve incrementally during a backtest.** One row per bar is a million writes
  for a benchmark run; batching at the end is both faster and simpler.

## Consequences

- A backtest that crashes loses its results. Acceptable, because it is reproducible by
  construction (ADR-0006), which is precisely the point.
- Paper-trading recovery needs the store to be the source of truth for open orders on restart; the
  engine rebuilds its in-memory state from it rather than the other way around.
