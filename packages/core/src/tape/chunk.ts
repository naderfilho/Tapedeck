/**
 * Columnar market-data storage — the "tape" of Tapedeck.
 *
 * Bars live in `Float64Array` columns rather than as an array of objects. A double represents
 * every integer up to 2^53 exactly, so fixed-point prices survive intact, reads need no unboxing,
 * and a million bars occupy seven contiguous buffers instead of a million heap objects (ADR-0004).
 *
 * Chunking is what lets asynchronous I/O feed a synchronous engine: the runner awaits one chunk of
 * tens of thousands of bars at a time and the engine walks it without ever yielding (ADR-0003).
 */

import type { InstrumentId } from '../instrument.ts';
import type { Duration } from '../time/timestamp.ts';
import { MarketDataError } from '../util/errors.ts';
import { unreachable } from '../util/assert.ts';

export interface BarChunk {
  readonly instrumentId: InstrumentId;
  /** Bar duration. Used for day-order expiry and reporting, never for arithmetic on prices. */
  readonly timeframe: Duration;
  readonly count: number;
  /** Inclusive start of each bar's interval, in microseconds. */
  readonly openTs: Float64Array;
  /** Exclusive end of each bar's interval. The instant the bar becomes knowable. */
  readonly closeTs: Float64Array;
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
}

export interface TickChunk {
  readonly instrumentId: InstrumentId;
  readonly count: number;
  readonly ts: Float64Array;
  readonly price: Float64Array;
  readonly size: Float64Array;
  /** `1` buyer-initiated, `-1` seller-initiated, `0` unknown. */
  readonly aggressor: Int8Array;
}

function grow(source: Float64Array, capacity: number): Float64Array {
  const next = new Float64Array(capacity);
  next.set(source);
  return next;
}

/**
 * Builds a {@link BarChunk} incrementally. Data adapters and tests use it; the engine only ever
 * reads the finished chunk.
 */
export class BarChunkBuilder {
  private readonly instrumentId: InstrumentId;
  private readonly timeframe: Duration;
  private capacity: number;
  private size = 0;
  private openTs: Float64Array;
  private closeTs: Float64Array;
  private open: Float64Array;
  private high: Float64Array;
  private low: Float64Array;
  private close: Float64Array;
  private volume: Float64Array;

  constructor(instrumentId: InstrumentId, timeframe: Duration, capacity = 1024) {
    this.instrumentId = instrumentId;
    this.timeframe = timeframe;
    this.capacity = Math.max(1, capacity);
    this.openTs = new Float64Array(this.capacity);
    this.closeTs = new Float64Array(this.capacity);
    this.open = new Float64Array(this.capacity);
    this.high = new Float64Array(this.capacity);
    this.low = new Float64Array(this.capacity);
    this.close = new Float64Array(this.capacity);
    this.volume = new Float64Array(this.capacity);
  }

  get count(): number {
    return this.size;
  }

  push(
    openTs: number,
    closeTs: number,
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number,
  ): void {
    if (this.size === this.capacity) this.reserve(this.capacity * 2);
    const i = this.size++;
    this.openTs[i] = openTs;
    this.closeTs[i] = closeTs;
    this.open[i] = open;
    this.high[i] = high;
    this.low[i] = low;
    this.close[i] = close;
    this.volume[i] = volume;
  }

  /**
   * Appends a whole chunk with a bulk copy per column.
   *
   * Anything that accumulates pages from a provider wants this rather than a loop over `push`: it
   * moves the columns with `TypedArray.set` instead of seven bounds-checked reads per bar, and it
   * removes the row of `?? 0` fallbacks that `noUncheckedIndexedAccess` otherwise demands at every
   * call site.
   */
  append(chunk: BarChunk): void {
    if (chunk.count === 0) return;
    const needed = this.size + chunk.count;
    if (needed > this.capacity) {
      let capacity = Math.max(1, this.capacity);
      while (capacity < needed) capacity *= 2;
      this.reserve(capacity);
    }
    const at = this.size;
    this.openTs.set(chunk.openTs.subarray(0, chunk.count), at);
    this.closeTs.set(chunk.closeTs.subarray(0, chunk.count), at);
    this.open.set(chunk.open.subarray(0, chunk.count), at);
    this.high.set(chunk.high.subarray(0, chunk.count), at);
    this.low.set(chunk.low.subarray(0, chunk.count), at);
    this.close.set(chunk.close.subarray(0, chunk.count), at);
    this.volume.set(chunk.volume.subarray(0, chunk.count), at);
    this.size = needed;
  }

  private reserve(capacity: number): void {
    this.capacity = capacity;
    this.openTs = grow(this.openTs, capacity);
    this.closeTs = grow(this.closeTs, capacity);
    this.open = grow(this.open, capacity);
    this.high = grow(this.high, capacity);
    this.low = grow(this.low, capacity);
    this.close = grow(this.close, capacity);
    this.volume = grow(this.volume, capacity);
  }

  /** Returns a chunk viewing exactly the pushed rows. The builder must not be reused after this. */
  build(): BarChunk {
    const n = this.size;
    return {
      instrumentId: this.instrumentId,
      timeframe: this.timeframe,
      count: n,
      openTs: this.openTs.subarray(0, n),
      closeTs: this.closeTs.subarray(0, n),
      open: this.open.subarray(0, n),
      high: this.high.subarray(0, n),
      low: this.low.subarray(0, n),
      close: this.close.subarray(0, n),
      volume: this.volume.subarray(0, n),
    };
  }
}

/** Builds a {@link TickChunk} incrementally. Same contract as {@link BarChunkBuilder}. */
export class TickChunkBuilder {
  private readonly instrumentId: InstrumentId;
  private capacity: number;
  private size = 0;
  private tsColumn: Float64Array;
  private priceColumn: Float64Array;
  private sizeColumn: Float64Array;
  private aggressorColumn: Int8Array;

  constructor(instrumentId: InstrumentId, capacity = 1024) {
    this.instrumentId = instrumentId;
    this.capacity = Math.max(1, capacity);
    this.tsColumn = new Float64Array(this.capacity);
    this.priceColumn = new Float64Array(this.capacity);
    this.sizeColumn = new Float64Array(this.capacity);
    this.aggressorColumn = new Int8Array(this.capacity);
  }

  get count(): number {
    return this.size;
  }

  /** `aggressor`: `1` buyer-initiated, `-1` seller-initiated, `0` unknown. */
  push(ts: number, price: number, size: number, aggressor: -1 | 0 | 1 = 0): void {
    if (this.size === this.capacity) {
      this.capacity *= 2;
      this.tsColumn = grow(this.tsColumn, this.capacity);
      this.priceColumn = grow(this.priceColumn, this.capacity);
      this.sizeColumn = grow(this.sizeColumn, this.capacity);
      const aggressors = new Int8Array(this.capacity);
      aggressors.set(this.aggressorColumn);
      this.aggressorColumn = aggressors;
    }
    const i = this.size++;
    this.tsColumn[i] = ts;
    this.priceColumn[i] = price;
    this.sizeColumn[i] = size;
    this.aggressorColumn[i] = aggressor;
  }

  build(): TickChunk {
    const n = this.size;
    return {
      instrumentId: this.instrumentId,
      count: n,
      ts: this.tsColumn.subarray(0, n),
      price: this.priceColumn.subarray(0, n),
      size: this.sizeColumn.subarray(0, n),
      aggressor: this.aggressorColumn.subarray(0, n),
    };
  }
}

function column(values: Float64Array, i: number, name: string): number {
  return values[i] ?? unreachable(`bar column ${name} shorter than count`);
}

/**
 * Rejects data the engine cannot reason about.
 *
 * Every rule here corresponds to a way a bad CSV silently produces a beautiful equity curve:
 * an out-of-order file replays the future, a high below the close makes a limit order that never
 * could have filled fill anyway, a non-integer price means someone skipped the fixed-point
 * conversion.
 */
export function validateBarChunk(chunk: BarChunk, previousCloseTs = -Infinity): void {
  const { count, openTs, closeTs, open, high, low, close, volume } = chunk;
  let lastClose = previousCloseTs;

  for (let i = 0; i < count; i++) {
    const o = column(open, i, 'open');
    const h = column(high, i, 'high');
    const l = column(low, i, 'low');
    const c = column(close, i, 'close');
    const v = column(volume, i, 'volume');
    const ot = column(openTs, i, 'openTs');
    const ct = column(closeTs, i, 'closeTs');

    if (
      !Number.isSafeInteger(o) ||
      !Number.isSafeInteger(h) ||
      !Number.isSafeInteger(l) ||
      !Number.isSafeInteger(c) ||
      !Number.isSafeInteger(v)
    ) {
      throw new MarketDataError(
        `bar ${String(i)}: prices and volume must be fixed-point integers`,
        { index: i, open: o, high: h, low: l, close: c, volume: v },
      );
    }
    if (h < l) {
      throw new MarketDataError(`bar ${String(i)}: high ${String(h)} is below low ${String(l)}`, {
        index: i,
        high: h,
        low: l,
      });
    }
    if (h < o || h < c || l > o || l > c) {
      throw new MarketDataError(`bar ${String(i)}: open/close fall outside the high/low range`, {
        index: i,
        open: o,
        high: h,
        low: l,
        close: c,
      });
    }
    if (v < 0) {
      throw new MarketDataError(`bar ${String(i)}: negative volume`, { index: i, volume: v });
    }
    if (!(ct > ot)) {
      throw new MarketDataError(`bar ${String(i)}: closeTs must be after openTs`, {
        index: i,
        openTs: ot,
        closeTs: ct,
      });
    }
    if (ot < lastClose) {
      throw new MarketDataError(
        `bar ${String(i)}: overlaps the previous bar (openTs ${String(ot)} < previous closeTs ${String(lastClose)})`,
        { index: i, openTs: ot, previousCloseTs: lastClose },
      );
    }
    lastClose = ct;
  }
}
