/**
 * Shared test fixtures.
 *
 * The test instruments use `priceExp: 0` and a point value of one, so a price of `100` really is
 * a hundred and a PnL of ten really is ten. Keeping the arithmetic legible in the tests is worth
 * more than exercising exotic scales here; `fixed.test.ts` and `engine.test.ts` cover the scales
 * that actually stress the safe-integer boundary.
 */

import {
  type BarChunk,
  type InstrumentId,
  type InstrumentSpec,
  BarChunkBuilder,
  MICROS_PER_MINUTE,
  asDuration,
  asTimestamp,
} from '@tapedeck/core';

/** A one-point-per-unit future: margin accounting, whole contracts, tick of 1. */
export const TEST_FUTURE: InstrumentSpec = {
  symbol: 'TF',
  venue: 'TEST',
  kind: 'future',
  currency: 'USD',
  priceExp: 0,
  qtyExp: 0,
  tickSize: '1',
  lotSize: '1',
  pointValue: '1',
  accounting: 'margin',
  initialMargin: '100',
};

/** The same numbers, but cash-settled, so buying spends money. */
export const TEST_SPOT: InstrumentSpec = {
  symbol: 'TS',
  venue: 'TEST',
  kind: 'spot',
  currency: 'USD',
  priceExp: 0,
  qtyExp: 0,
  tickSize: '1',
  lotSize: '1',
  pointValue: '1',
  accounting: 'cash',
};

export interface BarRow {
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v?: number;
}

export interface BarsOptions {
  readonly instrumentId?: number | undefined;
  readonly startTs?: number | undefined;
  readonly timeframe?: number | undefined;
}

/** Builds a chunk of consecutive bars from plain rows. */
export function bars(rows: readonly BarRow[], options: BarsOptions = {}): BarChunk {
  const timeframe = options.timeframe ?? MICROS_PER_MINUTE;
  const start = options.startTs ?? asTimestamp(0);
  const builder = new BarChunkBuilder(
    (options.instrumentId ?? 0) as InstrumentId,
    asDuration(timeframe),
    Math.max(1, rows.length),
  );
  rows.forEach((row, i) => {
    const openTs = start + i * timeframe;
    builder.push(openTs, openTs + timeframe, row.o, row.h, row.l, row.c, row.v ?? 1_000);
  });
  return builder.build();
}

/** Flat bars at a constant price. Useful as padding around the bar under test. */
export function flatBars(price: number, count: number, options: BarsOptions = {}): BarChunk {
  const rows: BarRow[] = [];
  for (let i = 0; i < count; i++) rows.push({ o: price, h: price, l: price, c: price });
  return bars(rows, options);
}

/** Splits a chunk into `parts` sub-chunks, for the chunk-invariance test. */
export function splitChunk(chunk: BarChunk, parts: number): BarChunk[] {
  const out: BarChunk[] = [];
  const size = Math.ceil(chunk.count / parts);
  for (let start = 0; start < chunk.count; start += size) {
    const end = Math.min(start + size, chunk.count);
    out.push({
      instrumentId: chunk.instrumentId,
      timeframe: chunk.timeframe,
      count: end - start,
      openTs: chunk.openTs.subarray(start, end),
      closeTs: chunk.closeTs.subarray(start, end),
      open: chunk.open.subarray(start, end),
      high: chunk.high.subarray(start, end),
      low: chunk.low.subarray(start, end),
      close: chunk.close.subarray(start, end),
      volume: chunk.volume.subarray(start, end),
    });
  }
  return out;
}

/** Money in this repository is scaled by 1e8; tests express expectations in whole currency. */
export const MONEY = 100_000_000;

export function money(units: number): number {
  return units * MONEY;
}
