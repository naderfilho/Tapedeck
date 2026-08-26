# 0017 — A tape carries its venue, and its venue carries its fees

- Status: Accepted
- Date: 2026-08-26
- Relates to: [0011](0011-read-only-market-data.md), [0015](0015-b3-sessions-contracts-and-data.md)

## Context

Everything the repository shipped came from one exchange. The fixtures were Binance spot, the demo
offered five Binance pairs, and `PRESETS.binanceSpot` was the only cost model anybody would reach
for. With one venue, nothing forces the question of whether a result is a claim about an asset or a
claim about a market.

It is a claim about a market, and the difference is not small. Coinbase Exchange's entry fee tier is
0.40% maker and 0.60% taker; Binance's is 0.100% either side. That is six times the taker cost on
the same asset in the same year. Run the repository's own 24/72 crossover over a year of hourly
Bitcoin and the gap decides the result: slightly profitable on one venue, down 21% on the other,
with fees coming to more than three times the gross profit.

A backtester that models costs as one global number cannot express that, and a page that lets a
visitor price one exchange's tape with another exchange's fees produces a figure that looks like a
measurement and is a mismatch.

## Decision

**A second venue, and the fee schedule travels with the tape.**

- `CoinbaseDataProvider` in `@tapedeck/data` fetches public candles from Coinbase Exchange, through
  the same `DataProvider` contract, with no credentials (ADR-0011). Historical bars only: paper
  trading is driven by the Binance socket, and this provider does not implement `stream`.
- `SPOT_FEES` in `@tapedeck/core` holds each venue's published schedule as the venue prints it — a
  percentage string, the tier it belongs to, the source URL and the date it was read, following the
  same shape as `B3_TARIFFS` (ADR-0015).
- `percentCommission` takes those percentages directly, because a fee of 0.075% is seven and a half
  basis points and does not fit in the integer-bps model. `bpsCommission` now rejects a fractional
  rate at configuration time rather than dying inside `mulDiv` on the first fill.
- `PRESETS` gains `binanceSpotBnb` and `coinbaseExchange` next to `binanceSpot`, and the CLI reads
  its `--preset` list off `PRESETS` rather than repeating it.
- On the demo, the cost options are **derived from the selected market's venue**. There is no path
  through the page that prices a Coinbase tape with Binance's fees. Two settings stay available
  everywhere because neither claims to be a venue: `ideal`, which charges nothing, and `stress`,
  which keeps the venue's own published fees and makes the fills worse.

## Alternatives considered

- **One "crypto fees" number, configurable.** What most tools do. It makes the sixfold difference
  above invisible, and it puts the burden of knowing a fee schedule on the person least likely to
  have read one.
- **Offer every preset for every market.** One line of code less, and it would let the page price a
  Coinbase tape at Binance's rates. The engine will accept whatever it is told; the site does not
  have to offer it.
- **Approximate Coinbase with Binance's tape.** The prices are close enough to look fine. They are
  a different book against a different quote currency, and the Coinbase year is genuinely ten hours
  shorter — the venue printed nothing during two outages. Approximating would have hidden all three.
- **Fill the Coinbase gaps by interpolation.** That would put prices nobody paid into a committed
  file. The gaps stay, and the page counts them.
- **A single "venue" object owning data and fees together.** Tidy until the first person wants a
  Binance tape under their own negotiated rate. Fees are an input to a run; the pairing is enforced
  where runs are configured, not in the type system.

## Consequences

- The repository ships twelve tapes rather than five, three of them the same assets from the second
  venue. The duplication is deliberate: it is what makes the cross-venue comparison possible.
- Anything quoting a fee has a source URL and a read date attached, and both venues revise them.
  The test asserts only that the citation is present; no test can tell you the figure is still
  current.
- `scripts/venue-compare.ts` runs both configurations on every site build, so the landing page's
  comparison is a run's output rather than a sentence somebody typed.
- A money figure on the demo is printed in the market's own quote currency: USDT on Binance, USD on
  Coinbase.
