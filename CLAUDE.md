# Working on Tapedeck

Read this before touching anything. The README explains the project to a stranger; this file
explains it to whoever is about to change it.

## Where things stand

Phases 1 to 3 are done and committed: the deterministic kernel, the incremental indicator library,
the data adapters and `.tape` format, the SQLite store, the metrics and HTML report, and the
`tapedeck` CLI. 424 tests, 97% statement coverage, a committed year of real hourly BTCUSDT.

Phase 4 is paper trading. Phase 5 is polish. Phase 6 is B3. The roadmap at the end of the README is
the authority on what each contains.

## How to work here

```bash
corepack pnpm install          # `pnpm` is not on PATH on the author's machine; corepack is
corepack pnpm -r build         # the root `pnpm build` script shells out to `pnpm`, which needs the shim
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm coverage         # runs the suite and enforces the floors
corepack pnpm bench
node examples/sma-crossover/src/main.ts   # end-to-end on real data, writes out/report.html
```

Everything runs without a build step: Node 24 strips types, and source imports carry real `.ts`
extensions that `tsc` rewrites on emit. A change is finished when format, lint, typecheck, build and
coverage are all green — not before.

**Writing files:** heredocs above roughly 8 KB get truncated by the shell here, and template
literals inside `node -e` get eaten. Use the Write and Edit tools for source files.

## Non-negotiables

These are the decisions the project exists to demonstrate. Do not quietly relax one; if a change
needs to, write an ADR arguing for it first.

1. **No lookahead.** An order submitted while processing a bar can never match against that bar.
   `packages/core/test/lookahead.test.ts` is written as a set of attacks; keep it that way.
2. **Money is fixed-point integers.** No float ever reaches the ledger. The portfolio tracks a cost
   basis in money, not an average entry price — a rounded average does not reconcile.
3. **The kernel is synchronous.** Strategy hooks return `void`. Asynchrony lives at the edges only.
4. **Determinism.** `Date.now()`, `new Date()`, `Math.random()` and `performance.now()` are blocked
   by lint inside `packages/core/src`. Adapters may read the clock; the kernel may not.
5. **The engine says what it could not know.** `stats.ambiguousBars`, `stats.subBarLatencyIgnored`
   and the warnings list print _above_ the results, everywhere.
6. **No `any`, no `@ts-ignore`.** `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on.
7. **Core has zero runtime dependencies** and imports no other workspace package. The allowlist for
   everything else is in ADR-0007.
8. **Read the ADRs before arguing with the code.** `docs/adr/` — thirteen of them, each with the
   alternatives that were rejected.

## Testing style

Property tests (fast-check) are not decoration here: four of them changed the design rather than
confirming it. When adding behaviour that has an invariant, assert the invariant over generated
input, not one hand-picked case. When a property test finds something, fix the implementation and
add the shrunk counterexample as a named regression test.

Tests assert invariants that hold for any strategy on any data — reconciliation, no lookahead,
reproducibility — never a particular PnL, because the fixtures are real prices.

## The working agreement with Nader

- **Do not ask for approval at the end of each phase.** He said so explicitly: summarise what was
  done, show the full suite result, and continue. The original prompt is the authority.
- He is a senior full-stack developer who built NTSL (Profit) and Tryd Script (Lua) strategies and
  HFT systems for B3 futures, equities, options and crypto between 2021 and 2025. Write for that
  reader: no hand-holding, no explaining what a stop order is.
- All code, comments, commits and documentation in **English**. Conversation with him in
  **Portuguese**.
- Conventional Commits, small and focused. Commit messages explain _why_, including the mistakes
  found along the way — several commits here record a bug a test caught and how the design changed.
- He asked to be corrected when a decision of his looks wrong. He has accepted every argued
  pushback so far; make the argument rather than silently complying.

## Questions he has not answered yet

Do not block on these — proceed with the stated assumption and flag it — but ask again when the
work touches them:

1. **Are his real strategies bar-closed or order-flow driven?** This decides how much the tick path
   matters. `onTick`, aggressor side and per-print matching already exist for this reason.
2. **Real B3 costs.** The figures in `PRESETS.b3Futures` and the margins in `INSTRUMENTS.WIN` /
   `WDO` are placeholders, marked as such. He has his brokerage note.
3. **Expiry rolls and the B3 session calendar** are currently phase 6. He may want them sooner.

He owes nothing else: instruments, data source and phase ordering were all settled.

## Phase 4, concretely

The claim to prove is ADR-0003: a strategy runs unchanged in backtest and live, because only two
things differ — which `Clock` answers `now()`, and who fills the event queue.

- `@tapedeck/data` gains a Binance WebSocket stream (the `ws` dependency is already allowed).
- The engine gains a live driver: the socket handler enqueues and calls a synchronous `drain()`,
  which is the same routine the backtest runs. `LiveClock` already exists and is already tested.
- `PaperRepository` in `@tapedeck/store` already has the schema; wire crash recovery so the session
  rebuilds its open orders and positions from the store rather than the other way round.
- **No credentials, ever.** The live feed drives the _simulated_ broker. The only thing that reaches
  the venue is a subscription. This is ADR-0011 and it is not negotiable.
- Backpressure is the queue's problem: a slow strategy grows the queue and the engine reports the
  lag rather than silently reordering.
- The hard part is testing it. Drive the socket from a fake, replay a recorded frame sequence, and
  assert that feeding the same events through the live path and the backtest path produces the same
  fills.

## Still owed from earlier phases

- A screenshot or recording of `out/report.html` for the README. The browser pane was unavailable
  when the report was built; the file is one command away from existing again.
- `OrderAmended` event: `broker.replace()` currently amends silently, documented as a gap.
- OCO orders: a bracket is two orders and a cancel in `onFill` today, which works but is not the
  same as the venue doing it.
