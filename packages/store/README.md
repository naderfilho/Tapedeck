# @tapedeck/store

Optional persistence on `node:sqlite`: a bar cache, run history and crash-recoverable paper-trading state.

Part of [Tapedeck](../../README.md). See **[the API guide](../../docs/api.md)** for how the pieces
fit together, and the [ADRs](../../docs/adr/) for why they are shaped this way.

**Runtime dependencies:** None beyond `node:sqlite`, which is built in. No native module, no compiler on install.

```ts
const store = openStore('runs.sqlite');
await store.runs.save('my-run', result);
```

Three responsibilities, deliberately kept apart
([ADR-0008](../../docs/adr/0008-optional-persistence-behind-store.md)):

- **bars** — downloaded market data, stored as `.tape` blobs, so the cache and a file on disk are
  the same bytes and neither can drift from the other.
- **runs** — finished backtests, written once, at the end.
- **paper** — live state, written as it happens, because a crash there loses something that cannot
  be recomputed.

The interface is asynchronous and this implementation is not, on purpose: a store behind a network
would be, and paying for a promise here keeps that option open.

## Licence

[PolyForm Noncommercial 1.0.0](../../LICENSE.md).
