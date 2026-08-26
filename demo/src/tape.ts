/**
 * The tapes the demo replays, and how a position is sized on them.
 *
 * Split from the run configuration so that `strategies.ts` can size a position without importing
 * the module that imports it. The circle is not hypothetical: a run needs a quantity, a quantity
 * needs an instrument, and an instrument is loaded per run.
 *
 * The list of markets itself lives in `markets.ts`, which has no imports, because the fixture
 * script and the site build need it too and neither can load the engine.
 */

import { type BarChunk, type runBacktest, asDuration, resampleBars } from '@tapedeck/core';
import { decodeBarTape } from '@tapedeck/data/codec';
import { type Market, MARKETS, VENUES, marketById } from './markets.ts';

export { type Market, type Venue, type VenueId, MARKETS, VENUES, marketById } from './markets.ts';

export const tickerFor = (id: string): string => marketById(id)?.ticker ?? id;
export const nameFor = (id: string): string => marketById(id)?.name ?? id;
export const quoteOf = (id: string): string => marketById(id)?.quote ?? 'USDT';

/** How a market reads when the venue matters, which on a page offering two of them is always. */
export const labelFor = (id: string): string => {
  const market = marketById(id);
  return market === undefined ? id : `${market.name} · ${VENUES[market.venue].label}`;
};

const MICROS_PER_HOUR = 3_600_000_000;

export interface Timeframe {
  readonly id: string;
  /** What the chip says. */
  readonly label: string;
  readonly micros: number;
}

/**
 * The bar clocks on offer.
 *
 * One file, three timeframes. The tapes are hourly and the slower two are aggregated in the tab by
 * `resampleBars`, which is exact — a maximum, a minimum, a first, a last and a sum over integers —
 * so the daily candles here are the daily candles, not an approximation of them, and nothing extra
 * is downloaded to see them.
 *
 * Worth switching for the same reason the markets are: the same rule on the same year is a
 * different strategy at a different sampling rate, and a result that only survives one of them was
 * never a result.
 */
export const TIMEFRAMES: readonly Timeframe[] = [
  { id: '1h', label: '1h', micros: MICROS_PER_HOUR },
  { id: '4h', label: '4h', micros: 4 * MICROS_PER_HOUR },
  { id: '1d', label: '1d', micros: 24 * MICROS_PER_HOUR },
];

export const DEFAULT_TIMEFRAME = '1h';

export const timeframeById = (id: string): Timeframe | undefined =>
  TIMEFRAMES.find((frame) => frame.id === id);

/** The instrument type the engine accepts, derived rather than imported. See the note in `Tape`. */
type InstrumentInput = Parameters<typeof runBacktest>[0]['instruments'][number];

export interface Tape {
  /**
   * Derived from `runBacktest` rather than imported, because what a tape decodes to is the *spec*
   * the engine accepts, not the resolved `Instrument` it builds internally. Naming the concrete
   * type compiled right up until the engine added a field to it.
   */
  readonly instrument: InstrumentInput;
  readonly chunk: BarChunk;
  readonly market: Market;
}

/** A tape on a slower clock, with what the aggregation had to leave out. */
export interface TapeView {
  readonly tape: Tape;
  /** Buckets built from fewer hours than the timeframe implies — a hole in the venue's data. */
  readonly partialBuckets: number;
  /** Hours at the end that did not complete a bucket and were not published as one. */
  readonly droppedTrailingBars: number;
}

/**
 * The example's size, in coins, so an unparameterised page opens on the published run.
 *
 * `examples/sma-crossover/src/main.ts` sizes in BTC, `0.25`, which is how a human says it for one
 * instrument. A page offering twelve cannot: 0.25 is a different amount of money on every tape.
 */
export const EXAMPLE_SIZE_COINS = 0.25;
export const EXAMPLE_MARKET = 'binance-BTCUSDT';

/**
 * Turns a position size in quote currency into the integer quantity the engine deals in.
 *
 * A raw quantity stopped meaning anything the moment there was a second instrument: `25000` is
 * 0.25 BTC on a tape reporting five decimals and 2,500 XRP on one reporting a single decimal.
 */
export function quantityFor(tape: Tape, notional: number): number {
  const price = (tape.chunk.close[0] ?? 0) / 10 ** tape.instrument.priceExp;
  if (price <= 0) return 0;
  const coins = notional / price;
  // Every tape here reports a lot size of exactly one unit at its own precision, so rounding to an
  // integer is the lot-size snap. `Math.max` keeps a tiny size legal rather than submitting a
  // zero-quantity order the engine would refuse.
  return Math.max(1, Math.round(coins * 10 ** tape.instrument.qtyExp));
}

export function describeQuantity(tape: Tape, qty: number): string {
  const coins = qty / 10 ** tape.instrument.qtyExp;
  const digits = Math.min(tape.instrument.qtyExp, coins < 1 ? 4 : 2);
  return `${coins.toLocaleString('en-US', { maximumFractionDigits: digits })} ${tape.market.ticker}`;
}

const tapes = new Map<string, Tape>();
const views = new Map<string, TapeView>();

/** Fetches and decodes a tape, once. `base` differs per page depth (`tapes/` vs `../demo/tapes/`). */
export async function loadTape(id: string, base: string): Promise<Tape> {
  const cached = tapes.get(id);
  if (cached !== undefined) return cached;

  const market = marketById(id);
  if (market === undefined) throw new Error(`no market called ${id}`);

  const response = await fetch(`${base}${market.id}-1h.tape`);
  if (!response.ok) {
    throw new Error(`could not load the tape for ${market.id}: ${String(response.status)}`);
  }
  const file = decodeBarTape(new Uint8Array(await response.arrayBuffer()));
  const tape: Tape = { instrument: file.instrument, chunk: file.chunk, market };
  tapes.set(market.id, tape);
  return tape;
}

/**
 * The same tape on the requested clock, aggregated once and kept.
 *
 * Hourly is the tape as it was downloaded and is returned untouched. Anything slower is built from
 * it here, in the tab, and the two counts that come back are the part a reader has to see: the
 * Coinbase tapes have two five-hour holes in them where the venue printed nothing, and a daily
 * candle covering one of those holes saw nineteen hours, not twenty-four.
 */
export function viewOf(tape: Tape, timeframeId: string): TapeView {
  const frame = timeframeById(timeframeId) ?? TIMEFRAMES[0];
  if (frame === undefined || frame.micros === tape.chunk.timeframe) {
    return { tape, partialBuckets: 0, droppedTrailingBars: 0 };
  }

  const key = `${tape.market.id}:${frame.id}`;
  const cached = views.get(key);
  if (cached !== undefined) return cached;

  const result = resampleBars(tape.chunk, asDuration(frame.micros));
  const view: TapeView = {
    tape: { instrument: tape.instrument, chunk: result.chunk, market: tape.market },
    partialBuckets: result.partialBuckets,
    droppedTrailingBars: result.droppedTrailingBars,
  };
  views.set(key, view);
  return view;
}

/** Every market, grouped the way the picker draws them. */
export function marketsByVenue(): readonly (readonly [string, readonly Market[]])[] {
  return Object.values(VENUES).map((venue) => [
    venue.label,
    MARKETS.filter((market) => market.venue === venue.id),
  ]);
}
