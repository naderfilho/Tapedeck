# @tapedeck/core

The deterministic event-driven kernel: events, clock, scheduler, columnar tape, simulated broker, fixed-point portfolio, trading calendar and futures contracts.

Part of [Tapedeck](../../README.md). See **[the API guide](../../docs/api.md)** for how the pieces
fit together, and the [ADRs](../../docs/adr/) for why they are shaped this way.

**Runtime dependencies:** None. Zero runtime dependencies, and it imports no other workspace package.

Everything an adapter, a report or a CLI needs is exported from the package root; nothing reaches
into `src/`.

```ts
import { PRESETS, asQty, runBacktest } from '@tapedeck/core';
```

Four things in here are load-bearing and are documented as decisions rather than as code:

- **No lookahead.** An order submitted while processing a bar carries an activation time strictly
  after that bar ([ADR-0005](../../docs/adr/0005-intrabar-execution-and-no-lookahead.md)).
- **Money is fixed-point integers**, and the ledger stores a cost basis rather than an average entry
  price ([ADR-0002](../../docs/adr/0002-fixed-point-money-float-indicators.md)).
- **The kernel is synchronous.** Strategy hooks return `void`
  ([ADR-0003](../../docs/adr/0003-synchronous-deterministic-kernel.md)).
- **Determinism is enforced by lint.** `Date.now()`, `new Date()`, `Math.random()` and
  `performance.now()` are build errors inside `src/`.

## Licence

[PolyForm Noncommercial 1.0.0](../../LICENSE.md).
