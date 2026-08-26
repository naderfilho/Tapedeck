# Working on Tapedeck

Read this before touching anything. The README explains the project to a stranger; this file
explains it to whoever is about to change it.

## Where things stand

All six phases are done and committed: the deterministic kernel, the incremental indicator library,
the data adapters and `.tape` format, the SQLite store, the metrics and HTML report, the `tapedeck`
CLI, live paper trading, and the B3 layer. A seventh landed after them: a second venue, venue-bound
fee schedules and timeframe aggregation (ADR-0017, ADR-0018). 685 tests, 96% statement coverage, a
committed year of real hourly candles for twelve markets across two exchanges.

The roadmap at the end of the README is the authority on what each phase contained. What is left is
in "Still owed" at the bottom of this file.

## How to work here

```bash
corepack pnpm install          # `pnpm` is not on PATH on the author's machine; corepack is
corepack pnpm -r build         # the root `pnpm build` script shells out to `pnpm`, which needs the shim
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm coverage         # runs the suite and enforces the floors
corepack pnpm bench
corepack pnpm fixtures         # refetch every tape; takes ids, e.g. `coinbase-BTC-USD`
corepack pnpm venues           # the cross-venue comparison the landing page quotes
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

**The site.** `site/` is a build output, gitignored, and wiped at the start of every build — editing
it changes nothing. The sources are `demo/`: `landing.html` (with `{{placeholders}}` the build
substitutes), `index.html` for the demo, `site.css` for all of it, and `build.ts`, which also grafts
the site header onto a copy of `out/report.html`.

`demo/src/markets.ts` is the one list of tapes, imported by the picker, by `demo/build.ts` and by
`scripts/fetch-fixtures.ts`. It has no imports on purpose: the fixture script runs under plain Node
with no bundler aliases. Adding a market means adding a row there and running `corepack pnpm
fixtures <id>`; the build throws rather than shipping a picker with a 404 in it.

`corepack pnpm site:build` is the whole thing — compile, replay the example, run the benchmark,
assemble — and it is the command `vercel.json` runs. `pnpm site` alone is the last step and needs
`out/report.html` to exist already.

**The site is deployed by Vercel and nowhere else.** The GitHub Pages workflow was retired: two
live copies of one site is two things to keep true, and the second was only ever a mirror.

The landing page's result figures are substituted from `out/metrics.json` and `out/venues.json`, not
typed in. They were hardcoded once and that is precisely the failure this project complains about: a
published number with no link to the run behind it, which survives the run that stops producing it.
`scripts/venue-compare.ts` writes the second file by running the same crossover on both exchanges,
and `site:build` runs it. If a figure is on the page, something computed it on this build.

**A change to the site is not published until it is pushed.** Vercel builds on push to `main`.
Check the deployed URL, not `site:serve`, before calling it done.

Dark by default and light under `prefers-color-scheme`, in `demo/site.css` for the two hand-written
pages and in `renderHtmlReport`'s inlined `STYLE` for the report, which carries the same token
names. ADR-0013 constrains the report to one file with no script and no network request; it says
nothing about colour, so following the reader's system does not relax it. **Printing does**
constrain it — the ADR's context names it — so `@media print` forces the palette back to ink on
white, drops the header and unwraps the table's scroll box. Verified from a generated PDF rather
than by reading the stylesheet: the page fill comes out `1 1 1`.

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
8. **Read the ADRs before arguing with the code.** `docs/adr/` — eighteen of them, each with the
   alternatives that were rejected. ADR-0014 amends ADR-0003; read them together.
9. **A tape and its fee schedule travel together.** A Coinbase tape priced with Binance's fees is a
   report about a market nobody traded in. `SPOT_FEES` carries each venue's published percentages
   with a source URL and a read date, and the demo derives its cost options from the selected
   market's venue — there is no path through the page that pairs them wrongly (ADR-0017).

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
2. ~~**Real B3 costs.**~~ Answered. `B3_TARIFFS` now carries the exchange's own published unit
   costs with the source URL and the date they were read; brokerage is an explicit input defaulting
   to zero, which is a real configuration on minis rather than a flattering omission. Re-read the
   sources when a result depends on them.

   The **margins** in `INSTRUMENTS.WIN` / `WDO` are a different problem and are still wrong. B3's
   overnight margin is computed per portfolio by the CORE methodology, not per contract, and the
   day-trade margin is a number each broker sets. There is no constant to look up, so the fields
   stay as declared placeholders — and `marginUsed()` should be read as "what this configuration
   would have blocked", never as what B3 would have required.

3. **Which B3 contracts matter first** — index and dollar minis are assumed, but a roll calendar is
   only useful for the contracts actually traded.

## Corrections the build forced

Five things this file, or an ADR, predicted wrongly. They are here because the corrections are more
informative than the predictions were, and because every one of them was found by something running
rather than by someone thinking:

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
- **A bracket built from two orders and a `cancel` in `onFill` can execute both legs.** The cancel
  lands after the matcher has already looked at the next candidate on the same bar. Native OCO
  reduces siblings inside the fill instead; `oco.test.ts` keeps the old bug reproduced against the
  old pattern so the difference stays visible.
- **The B3 example found two bugs in itself, both from the engine being right.** Asking "how long
  until the close" from a bar's own close answers with tomorrow's bell, because a session is
  half-open. And an exit sent on the closing bar fills at the next session's open, because an order
  cannot match against the bar that produced it — so being flat overnight means exiting one bar
  early. Both are regression tests now.
- **The demo drew its own chart box and got it inside out.** `Box.right` and `Box.bottom` are
  insets from the far edge; the demo passed `width - 14` and `height - 26` as though they were
  coordinates, so the usable width came out negative and a year of hourly bars collapsed into a
  32×14 scribble in the corner of an empty panel. It went unseen because the demo also skipped the
  axes — with nothing else on the canvas there was nothing for it to look wrong against. Both
  charts now use the report's `CHART_BOX`, `SMALL_BOX` and `axes`, and `charts.test.ts` asserts
  that a shipped box leaves a plot area inside its canvas.

- **Coinbase publishes candles as JSON numbers, not strings.** By the time `JSON.parse` has run the
  decimal is already a double, so the string discipline the Binance provider keeps is not available.
  `decimalString` converts without adding a second error — `String(n)` is the shortest decimal that
  round-trips — and expands the exponential notation `parseFixed` cannot read. The loss is
  documented in the provider's header rather than hidden.
- **Both Coinbase tapes are ten hours short of a year**, at 2025-10-25T15:00Z and 2026-05-08T01:00Z,
  identically across all three products. That is the venue, not the pager: the same holes come back
  from a hand-rolled `curl`. They stay as holes, and `resampleBars` counts the buckets they leave
  partial so the demo can print it above the numbers.
- **A bare `1fr` grid track is at least as wide as its content.** The hero's mobile layout used one,
  so the code panel's longest line pushed the whole landing page sideways on a phone and cut the
  headline off — with `overflow-x: auto` sitting uselessly on the `<pre>` the entire time. It is
  `minmax(0, 1fr)` now.
- **Half the demo is built by script, so the language has to be applied before it is drawn.** The
  strategy chips and the cost options render through `t()`; rendering them before `setup()` meant a
  Portuguese page opened with an English picker until something re-ran.

## Still owed from earlier phases

- ~~A screenshot of `out/report.html` for the README.~~ Done: `docs/images/report.png`, cut after
  the equity chart, linking to the page CI publishes at
  <https://tapedeck-nader-filhos-projects.vercel.app/>. The browser pane can drive the page and read
  the DOM back, but it cannot screenshot unless it is on screen, so the image is captured with
  headless Chrome — which is also what makes it reproducible:

  ```bash
  node examples/sma-crossover/src/main.ts
  chrome --headless --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1280,985 --screenshot=docs/images/report.png out/report.html
  ```

  Regenerate it whenever the report's layout changes, or the README will be showing a page the
  code no longer produces.

- ~~`OrderAmended` event~~ and ~~OCO orders~~: both done. `NewOrder.oco` groups legs and a fill
  reduces its siblings before the next candidate on the same bar is considered, which is the window
  the old two-orders-and-a-cancel pattern left open. `oco.test.ts` reproduces the old bug against
  the old pattern so the difference stays visible.
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
