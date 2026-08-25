# @tapedeck/data

The asynchronous edge: CSV, Binance REST and WebSocket, B3 daily price reports, the columnar `.tape` format, and continuous futures series.

Part of [Tapedeck](../../README.md). See **[the API guide](../../docs/api.md)** for how the pieces
fit together, and the [ADRs](../../docs/adr/) for why they are shaped this way.

**Runtime dependencies:** `zod`, for validating data that crosses the process boundary.

Nothing in here runs inside the engine's loop. A provider yields chunks; the runner awaits one chunk
of tens of thousands of bars at a time; the engine walks each chunk without ever yielding.

```ts
const tape = readBarTapeFileSync('data/btc.tape');
const stitched = stitchContinuous({ contracts, rollOn: 'volume' });
```

Two things worth knowing before you use it:

- **Binance data is public and committed** to this repository; **B3 data is neither.** B3's
  consumption policy permits internal use and requires prior approval to redistribute, so
  `B3DataProvider` writes a local `.tape` and nothing here ships its prices
  ([ADR-0015](../../docs/adr/0015-b3-sessions-contracts-and-data.md)).
- **A back-adjusted price never traded.** `stitchContinuous` says so in its warnings, every time.

## Licence

[PolyForm Noncommercial 1.0.0](../../LICENSE.md).
