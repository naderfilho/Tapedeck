# Working on Tapedeck

Read this before touching anything. The README explains the project to a stranger; this file
explains it to whoever is about to change it.

## Where things stand

Phases 1 to 4 are done and committed: the deterministic kernel, the incremental indicator library,
the data adapters and `.tape` format, the SQLite store, the metrics and HTML report, the `tapedeck`
CLI, and live paper trading. 560 tests, 97% statement coverage, a committed year of real hourly
BTCUSDT.

Phase 5 is polish. Phase 6 is B3. The roadmap at the end of the README is the authority on what
each contains.

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

**Running the CLI by hand:** `node packages/cli/src/cli.ts …` runs the CLI from source but resolves
`@tapedeck/core` through `node_modules` to that package's **`dist`**. Vitest aliases the workspace
to `src` and does not. So a change to core that you are testing through the CLI needs
`corepack pnpm -r build` first, or you will be debugging the previous build — which happened while
phase 4's live session was being smoke-tested, and looked exactly like a bug in the new code.

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
8. **Read the ADRs before arguing with the code.** `docs/adr/` — fourteen of them, each with the
   alternatives that were rejected. ADR-0014 amends ADR-0003; read them together.

## Testing style

Property tests (fast-check) are not decoration here: five of them changed the code rather than
confirming it. When adding behaviour that has an invariant, assert the invariant over generated
input, not one hand-picked case. When a property test finds something, fix the implementation and
add the shrunk counterexample as a named regression test.

Tests assert invariants that hold for any strategy on any data — reconciliation, no lookahead,
reproducibility — never a particular PnL, because the fixtures are real prices.

## Conventions

- **English everywhere** — code, comments, commit messages, documentation, ADRs.
- **Conventional Commits, small and focused.** A message explains _why_, not what the diff already
  shows. Several commits here record a bug a test caught and how the design changed because of it;
  that is the standard, not an exception.
- **Write for someone who trades.** No hand-holding, no explaining what a stop order is. The reader
  knows the domain and is here for the engineering decisions.
- **Argue rather than comply.** If a decision recorded here looks wrong, make the case for changing
  it — in an ADR if it touches a non-negotiable. Silently working around one is the failure mode
  this file exists to prevent.
- **Finished means green.** Format, lint, typecheck, build and coverage, in that order.

## Open questions

Do not block on these — proceed with the stated assumption, flag it in the output, and raise it
again when the work actually touches them:

1. **Are the strategies this is built for bar-closed or order-flow driven?** Decides how much the
   tick path matters. `onTick`, aggressor side and per-print matching already exist for this
   reason, and are the less-exercised half of the engine.
2. **Real B3 costs.** The figures in `PRESETS.b3Futures` and the margins in `INSTRUMENTS.WIN` /
   `WDO` are placeholders and marked as such in the code. They need to come off a real brokerage
   note before any B3 result means anything.
3. **Which B3 contracts matter first** — index and dollar minis are assumed, but a roll calendar is
   only useful for the contracts actually traded.

## What phase 4 turned out to be

Done. The shape it landed in, because it is not quite the shape this file predicted:

- `LiveSession` in `packages/core/src/engine/live.ts` owns a bounded FIFO and a synchronous
  `drain()`. The socket handler enqueues and drains; nothing in the kernel changed.
- **The kernel runs on event time in live mode too.** The prediction in this file was that
  `LiveClock` would answer `now()` live. It cannot: venue timestamps and our wall clock differ by
  an unknown skew, so a machine two seconds fast would fill differently on identical data, and the
  equivalence test could not exist at all. Lag is measured and reported instead. ADR-0014 argues
  it and amends ADR-0003.
- Heartbeats (`Engine.advanceTo`) move time when the market is quiet, so an order's latency is not
  held hostage by an illiquid instrument.
- `ws` was not needed. Node 24 has a global `WebSocket`, so `@tapedeck/data` still depends on
  nothing but `zod`, and the row ADR-0007 reserved for `ws` is gone.
- Crash recovery restores the **account** and not the strategy. Two equivalence tests failed on
  this before it was understood: a closure field does not come back, and `bar.index` restarts
  because it counts this run's bars. Both are documented in `Strategy.onInit`, in the resumed
  session's warnings, and in a test that asserts the counter really does reset.
- `tapedeck paper` wires it together. Its feed and its stop condition are injectable, which is how
  the tests drive it without a socket and without waiting on a clock.

## Still owed from earlier phases

- ~~A screenshot of `out/report.html` for the README.~~ Done: `docs/images/report.png`, cut after
  the equity chart, linking to the page CI publishes at
  <https://naderfilho.github.io/Tapedeck/>. The browser pane is still unavailable here, so it is
  captured with headless Chrome, which is also what makes it reproducible:

  ```bash
  node examples/sma-crossover/src/main.ts
  chrome --headless --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1280,985 --screenshot=docs/images/report.png out/report.html
  ```

  Regenerate it whenever the report's layout changes, or the README will be showing a page the
  code no longer produces.

- `OrderAmended` event: `broker.replace()` currently amends silently, documented as a gap.
- OCO orders: a bracket is two orders and a cancel in `onFill` today, which works but is not the
  same as the venue doing it.
- A paper session's report reuses the backtest metrics unchanged. Some of them — a CAGR of -92%
  extrapolated from nineteen seconds of wall time, which is what the first real session printed —
  say nothing at all about a session that short. Phase 5 should decide which metrics a live
  session should print, and which it should refuse to.
- What has now been done against the real Binance socket: aggTrade and `kline_1m` together for two
  and a half minutes (1,535 events, two closed candles, 1,387 prints, queue never above 1), the
  SQLite store written as it went, and the session resumed from that store in a second process —
  which picked the position up at 1000, added its own 1000 with a correctly blended cost basis,
  and gave its first fill id **10** rather than id 1. That last detail is the whole reason
  `PaperState.counters` exists: without it `INSERT OR REPLACE INTO paper_fills` would have
  overwritten fill 1 and lost a trade from the audit trail without a word.
- What still has **not** been seen live: a reconnection (the gap path), a session long enough to
  matter, and a real crash rather than a clean stop. Those paths are covered against a fake and
  the fake drives the same code, but the weather has not been.
