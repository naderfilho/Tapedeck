# @tapedeck/indicators

Incremental SMA, EMA, RMA, RSI, ATR, Bollinger bands, VWAP and MACD, behind one contract the engine drives.

Part of [Tapedeck](../../README.md). See **[the API guide](../../docs/api.md)** for how the pieces
fit together, and the [ADRs](../../docs/adr/) for why they are shaped this way.

**Runtime dependencies:** None. It depends on core's _types_ only, never on its runtime.

Every indicator updates in O(1) per bar and allocates nothing on the hot path. The engine owns the
update and runs it after resting orders have matched and before `onBar`, so a value read inside
`onBar` always belongs to the bar being shown — never one stale, never one early
([ADR-0010](../../docs/adr/0010-indicator-contract.md)).

```ts
const fast = ctx.use(sma({ period: 24 }));
const bands = ctx.use(bollinger({ period: 20, deviations: 2 }));
```

Indicators compute in float64 on purpose: an indicator produces a _signal_, not money. The boundary
is explicit — a value that becomes an order price passes through `roundToTick()`.

## Licence

[PolyForm Noncommercial 1.0.0](../../LICENSE.md).
