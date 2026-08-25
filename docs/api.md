# The API

A guided tour, not a generated reference. Generated reference is two hundred pages nobody reads and
the source is already commented; what a reader actually needs is the shape of the thing and the
half-dozen rules that are not negotiable. Everything below is exported from `@tapedeck/core` unless
it says otherwise.

- [A strategy, end to end](#a-strategy-end-to-end)
- [The strategy contract](#the-strategy-contract)
- [Instruments and scales](#instruments-and-scales)
- [Orders](#orders)
- [Execution models](#execution-models)
- [Data](#data)
- [Calendars and futures](#calendars-and-futures)
- [The result, metrics and the report](#the-result-metrics-and-the-report)
- [Paper trading](#paper-trading)
- [Six rules you cannot break](#six-rules-you-cannot-break)

## A strategy, end to end

```ts
import { INSTRUMENTS, PRESETS, asQty, runBacktest } from '@tapedeck/core';
import { sma } from '@tapedeck/indicators';
import { readBarTapeFileSync } from '@tapedeck/data';
import { computeMetrics, formatMetrics } from '@tapedeck/report';

const tape = readBarTapeFileSync('fixtures/binance-BTCUSDT-1h.tape');

const result = runBacktest(
  {
    instruments: [tape.instrument],
    strategy: () => {
      let fast, slow;
      return {
        id: 'crossover',
        onInit(ctx) {
          fast = ctx.use(sma({ period: 24 }));
          slow = ctx.use(sma({ period: 72 }));
        },
        onBar(bar, ctx) {
          if (!fast.ready || !slow.ready) return;
          const position = ctx.portfolio.position(bar.instrumentId).qty;
          if (fast.value > slow.value && position === 0) {
            ctx.submit({
              instrumentId: bar.instrumentId,
              side: 'buy',
              type: 'market',
              qty: asQty(25_000),
            });
          }
        },
      };
    },
    params: {},
    initialCash: '100000',
    seed: 1,
    execution: PRESETS.binanceSpot(),
  },
  [tape.chunk],
);

console.log(formatMetrics(computeMetrics(result), 'USDT'));
```

That is the whole surface for a simple case: describe the instruments, hand over a strategy factory,
feed chunks, read a result.

## The strategy contract

A strategy is a plain object. Every hook is **synchronous and returns `void`** — see
[ADR-0003](adr/0003-synchronous-deterministic-kernel.md) for why, and note that it is not a style
preference.

```ts
interface Strategy<P> {
  readonly id: string;
  onInit(ctx: StrategyContext, params: P): void;
  onBar?(bar: BarEvent, ctx: StrategyContext): void;
  onTick?(tick: TickEvent, ctx: StrategyContext): void;
  onFill?(fill: OrderFilledEvent, ctx: StrategyContext): void;
  onReject?(rejection: OrderRejectedEvent, ctx: StrategyContext): void;
  onCancel?(cancellation: OrderCancelledEvent, ctx: StrategyContext): void;
  onAmend?(amendment: OrderAmendedEvent, ctx: StrategyContext): void;
  onStop?(ctx: StrategyContext): void;
}
```

Strategies are constructed **per run** by a factory, never shared. A parameter sweep runs the same
strategy hundreds of times, and state leaking between runs is the second-most-common way a backtest
lies.

`ctx` is everything a strategy may touch:

| Member                                     | What it is                                                       |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `now()`, `clock`                           | Simulated time. Event time, live and in backtest.                |
| `calendar`                                 | The venue's sessions. `ALWAYS_OPEN` unless a run declared one.   |
| `portfolio`                                | Read-only: `cash()`, `equity()`, `position(id)`, `marginUsed()`. |
| `use(indicator, options?)`                 | Registers an indicator; returns a read-only handle.              |
| `submit`, `cancel`, `replace`              | Order entry.                                                     |
| `order(id)`, `openOrders(instrumentId?)`   | Immutable snapshots.                                             |
| `instrument(id)`, `instrumentOf(venue, s)` | Contract details.                                                |
| `rng`                                      | The run's seeded random stream, forked for the strategy.         |
| `log`                                      | Buffered, timestamped with simulated time.                       |
| `signal(...)`                              | Records an intent, so the report can compare it to execution.    |

Note what is **absent**: the tape, the chunk, the engine. A strategy has no way to reach a bar it
has not been handed, which is what makes lookahead a compile-time impossibility rather than a
code-review responsibility.

The bar handed to `onBar` is a **reused view**. Read it, do not keep it. Under test and in
development it is revoked when the callback returns, so keeping it fails loudly rather than
silently reading the wrong bar later.

## Instruments and scales

There is no default precision anywhere. If a scale is not declared, it does not exist.

```ts
const WIN: InstrumentSpec = {
  symbol: 'WIN',
  venue: 'B3',
  kind: 'future',
  currency: 'BRL',
  priceExp: 0, // whole index points
  qtyExp: 0, // whole contracts
  tickSize: '5',
  lotSize: '1',
  pointValue: '0.20', // one point is twenty centavos
  accounting: 'margin',
};
```

Decimal **strings**, so a spec reads like the contract sheet and no float participates in the
conversion. `INSTRUMENTS` carries `WIN`, `WDO` and `BTCUSDT`; `b3Stock(symbol)` builds an equity
spec.

`accounting` decides how buying affects cash: `cash` (spot, equities) spends cash and the position
is worth its market value; `margin` (futures) spends only commission and the position is worth its
unrealised PnL. Both settle to the same identity, which the property tests assert:

```text
equity == initialCash + realised + unrealised - commission
```

## Orders

```ts
ctx.submit({
  instrumentId,
  side: 'buy',
  type: 'limit', // market | limit | stop | stop_limit
  qty: asQty(2),
  limitPrice: asPrice(105),
  tif: 'day', // gtc | day | ioc | fok
  tag: 'entry',
  oco: 'bracket-1',
});
```

`oco` groups legs of a bracket. A fill reduces its siblings **the instant it is applied**, before
the next candidate on the same bar is considered — which is the difference between an OCO and two
orders plus a `cancel` in `onFill`. The second pattern leaves the sibling live for one more
candidate, and a bar that touches both levels executes both.

`tif: 'day'` expires at the **venue's next session close**, not at midnight UTC. On `ALWAYS_OPEN`
those are the same thing.

`replace(id, amend)` changes an order in place, keeping its id and queue position, and emits
`OrderAmended`. A rejected amendment changes nothing at all.

## Execution models

Four independent models, composed into an `ExecutionConfig`:

```ts
execution: {
  slippage: fixedTicksSlippage(1),      // or bpsSlippage, rangeFractionSlippage, withJitter
  commission: b3FuturesCommission({ tariff: B3_TARIFFS.WIN, dayTrade: true }),
  latency: uniformLatency(5_000, 25_000),
  liquidity: volumeParticipation(500),   // basis points of the bar's volume
  intrabar: 'pessimistic',               // | 'optimistic' | 'ohlc-path'
}
```

`PRESETS` has `ideal`, `binanceSpot`, `b3Futures` and `b3Stocks`. Every parameter is an integer in
basis points, never a float fraction, so two machines cannot disagree about the last unit of a
commission.

`intrabar` decides what happens when more than one resting order could have filled inside one bar.
It is **counted** in `stats.ambiguousBars` whatever you choose — a run where that is a large share
of the trades is a run whose numbers are a guess, and the report says so.

## Data

`@tapedeck/data` is the asynchronous edge. Nothing in it runs inside the engine's loop.

```ts
// A local file
const tape = readBarTapeFileSync('data/btc.tape');

// Public historical candles
const binance = new BinanceDataProvider();
for await (const chunk of binance.bars({ symbol: 'BTCUSDT', timeframe, from, to })) {
  engine.feedBars(chunk);
}

// A CSV export you already have
const csv = new CsvBarProvider({ path: 'export.csv', instrument, timeframe });
```

The `.tape` format is columnar and self-describing: it carries the instrument, so the integers in it
have units. A tape and the SQLite bar cache store the same bytes, so neither can drift from the
other.

## Calendars and futures

```ts
const calendar = new TradingCalendar(B3);
calendar.isOpen(ts);
calendar.nextClose(ts);
calendar.tradingDaysBetween(from, to);
```

`B3` and `ALWAYS_OPEN` ship; a calendar is a plain spec, so overriding the holiday table is a
spread. B3's is transcribed and **not authoritative** — verify it before a result depends on it.

Futures contracts are coordinates, not names:

```ts
const front = frontContract(B3_SERIES.WIN, calendar, ts); // e.g. WINJ25
contractsBetween(B3_SERIES.WIN, calendar, from, to);
```

Front month is the nearest contract whose **roll** has not passed, not the nearest unexpired one.
Those differ for a few sessions before every expiry, and that is exactly where a backtest trades an
illiquid contract against quotes nobody was making.

Stitching lives in `@tapedeck/data`:

```ts
const series = stitchContinuous({ contracts, rollOn: 'volume', method: 'difference' });
series.warnings.forEach((w) => console.log(w)); // print these above the results
```

## The result, metrics and the report

`RunResult` carries the equity curve, the trade list, every fill and amendment, the open positions,
the logs, the stats and the **warnings**. `computeMetrics(result, options?)` turns it into `Metrics`;
`formatMetrics`, `metricsToJsonString` and `renderHtmlReport` render it.

Two options matter:

- `periodsPerYear` — pass it for any instrument that closes overnight. Inference uses the median
  spacing of the equity curve, which is right for a continuous market and wrong for B3.
- `qtyExp` — so per-unit costs read per contract rather than per fixed-point integer.

`breakEvenCommissionPerUnit` is the commission at which the run's profit is exactly zero. It is the
most useful cost number when the real tariff is unknown, because it does not depend on knowing it.

The HTML report is one self-contained file: no `<script>`, no CDN, no network
([ADR-0013](adr/0013-report-is-a-file.md)).

## Paper trading

The same strategy, the same kernel, a socket instead of a file.

```ts
const session = new LiveSession(runOptions, { sessionId: 'btc-1', store });
await session.start(); // restores from the store if this id has run before

stream.onBars = (chunk) => session.receive({ kind: 'bars', chunk });
// ...
const result = await session.stop(); // the same RunResult a backtest produces
```

`session.warnings()` reports lag, refused events, feed gaps and whether the account was restored.
Read [ADR-0014](adr/0014-paper-trading-runs-on-event-time.md) before assuming what the clock does:
the kernel runs on **event time** in both modes, and wall time is measured, not applied.

A restarted session restores the **account** — cash, cost basis, resting orders, the id counters —
and not the strategy's memory. A field in a closure does not come back, and `bar.index` restarts.

## Six rules you cannot break

1. **Hooks are synchronous.** No `await` inside a strategy. I/O happens outside the kernel and
   arrives as a future event.
2. **Do not keep the bar.** It is a reused view.
3. **Money is fixed-point integers.** Never build a price from a float without `roundToTick`.
4. **Do not read the clock.** `Date.now()` and `Math.random()` are lint errors inside
   `packages/core/src`, and a strategy that reads them is a strategy whose backtest is not
   reproducible.
5. **An order cannot fill on the bar that produced it.** Anything that appears to is a bug — please
   report it.
6. **Read the warnings.** They are the parts of the answer the data could not support, and they
   print above the numbers everywhere for that reason.
