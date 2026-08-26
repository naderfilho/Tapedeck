# 0018 — Slower timeframes are aggregated, not downloaded

- Status: Accepted
- Date: 2026-08-26
- Relates to: [0004](0004-columnar-tape-and-reused-bar-views.md), [0009](0009-tape-binary-format.md)

## Context

A strategy's result is as much a claim about its sampling rate as about its rule. A 24/72 crossover
on hourly bars and the same rule on daily bars are different strategies, and one that only survives
one of the two was never a result. The demo could not show that: it shipped hourly tapes and offered
hourly bars.

The obvious fix is more files. A year of hourly bars is 480 KiB in the `.tape` format, and three
timeframes across twelve markets would have been thirty-six files and about seventeen megabytes in
the repository — to publish data the repository already has, three times over, at three resolutions.

## Decision

`resampleBars` in `@tapedeck/core` rebuilds a `BarChunk` on a slower timeframe: open of the first
bar, close of the last, maximum high, minimum low, summed volume. Every operation is a comparison or
an addition over integers, so a resampled tape is exactly as fixed-point as the one it came from and
no price is averaged into existence.

Two rules make the output honest rather than merely convenient:

- **Buckets align to the epoch, not to the first bar.** A 4h bar starting at 00:00 UTC is the bar
  every venue and every chart means. Starting the first bucket wherever a file happens to begin
  produces a series that agrees with nothing, including itself after the file is re-cut.
- **A bucket that is still forming is not a bar.** The trailing group is dropped unless the source
  covers all of it — the same rule the data providers apply to a candle whose close lies past the
  requested end. Publishing one hands a strategy a bar the market had not finished printing.

Interior gaps are a different case and are kept, not filled. A bucket built from fewer source bars
than the ratio implies is all the venue printed, so the result reports `partialBuckets`, and the
demo prints that count with the run's other caveats, above the numbers.

The demo aggregates in the tab. Nothing extra is fetched to switch timeframe.

## Alternatives considered

- **Ship a file per timeframe.** Seventeen megabytes of derived data, three chances for a market to
  be in one list and not another, and a fetch on every timeframe change.
- **Resample in the site build and inline the result.** Same duplication, moved into the artefact.
- **Ask the venue for 4h and 1d candles.** Both exchanges publish them, and the answers would differ
  from ours in ways nobody could see: a venue aggregates its own trades, including any it did not
  print as an hourly candle. Deriving from the shipped tape means the daily bar and the hourly bars
  under it are the same data, which is the property the page is demonstrating.
- **Let a strategy declare a timeframe and have the engine resample.** The kernel would then be
  deciding what a bar is. It stays a transformation applied to a tape before the engine sees it.

## Consequences

- `resample(x, 4h)` then `resample(·, 12h)` gives the same series as `resample(x, 12h)`, and a
  property test asserts it. Without that, which route the page took to a daily bar would change the
  bar, and two visitors could see different candles.
- Fewer bars means fewer trades and a coarser equity curve; the metrics annualise from the bar
  interval and follow it.
- The aggregation is exact, but it can only be as complete as its input. Both Coinbase tapes have
  two five-hour holes in them, so at 1d the page reports two partial bars rather than pretending to
  twenty-four hours it never saw.
- Anything finer than the shipped tape is refused rather than interpolated. The tapes are hourly;
  fifteen-minute bars are a download, not a derivation.
