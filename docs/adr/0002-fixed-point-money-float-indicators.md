# 0002 — Fixed-point integers for money, float64 for indicators

- Status: Accepted
- Date: 2026-08-25

## Context

Binary floating point cannot represent 0.1 exactly. Over a backtest with hundreds of thousands of
fills, accumulated representation error shows up as a PnL that does not reconcile with the sum of
its trades. At the same time the engine targets ~1M bars/second, which rules out anything that
allocates an object per arithmetic operation.

## Decision

Two different number regimes, with an explicit, tested boundary between them.

### Money, prices and quantities are fixed-point integers stored in `number`

- `PriceInt = round(price * 10 ** instrument.priceExp)`
- `QtyInt   = round(qty   * 10 ** instrument.qtyExp)`
- `MoneyInt = round(money * 10 ** 8)` — `MONEY_EXP = 8`, currency-independent minor units
- `Instrument.pointValue` is a `MoneyInt`: the money value of one full price point. WIN is
  0.20 BRL per point, so `pointValue = 20_000_000`. Contract multipliers stay integral too.

All of these are branded types, so a `PriceInt` cannot be silently passed where a `MoneyInt` is
expected.

### The hot path never multiplies money

Replay, indicator updates and order matching only compare and add integers, which stay exact
inside the safe-integer range. Multiplication happens exclusively in the accounting path — once
per fill, not once per bar — through `mulDiv` / `mulMulDiv` helpers that compute the intermediate
product in `bigint` and round explicitly. The product of a price and a quantity overflows
`Number.MAX_SAFE_INTEGER` at realistic crypto precision (8 decimals of price times 8 of quantity),
so this is a correctness requirement, not paranoia.

### The ledger stores a cost basis, not an average entry price

An average entry price has to be rounded to the instrument's price scale, and every PnL computed
from a rounded average inherits that error. The first property test written against the portfolio
found it immediately: on a `priceExp: 0` instrument, `equity` and
`realised + unrealised - commission` disagreed by one currency unit after an averaged entry.

So positions carry `costBasis`, an exact amount of money. Closing part of a position releases an
exact proportion of it (`mulDiv(costBasis, closedQty, openQty)`) and subtracts that same value from
the remaining basis, so no residue accumulates across partial closes. `avgEntry` still exists and
is still reported — reconstructed from the cost basis, for display only.

### Indicators compute in float64

An EMA in fixed point accumulates rounding bias and is slower for no benefit: an indicator
produces a _signal_, not money. The boundary is explicit — an indicator value that becomes an
order price must pass through `roundToTick()`, which returns a `PriceInt`.

## Alternatives considered

- **decimal.js / big.js.** 50-200x slower than native arithmetic and allocates per operation.
  On the hot path it makes the performance target unreachable; in accounting only, it buys nothing
  that bigint mulDiv does not already give exactly.
- **bigint everywhere.** Exact and easy to reason about, but 5-10x slower than `number` for the
  same operation, heap-allocated, and unusable inside a `Float64Array` column.
- **float64 with epsilon comparisons.** What most open-source backtesters do. It fails exactly
  where it matters: reconciling a long run's PnL against its own trade list.

## Consequences

- Every instrument must declare its scales; there is no default precision.
- Conversion from human input happens once, at the edge, preferably from a _string_
  (`parseFixed`), so that no float ever participates in the conversion.
- Reading a fixed-point number in a debugger is unpleasant; `formatFixed` exists for that.
- A dev-mode assertion checks `Number.isSafeInteger` at every fixed-point boundary.
