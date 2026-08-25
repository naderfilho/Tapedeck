/**
 * Data source contracts (ADR-0003).
 *
 * This is the asynchronous edge of the system. Everything past it is synchronous: a provider
 * yields chunks, the runner awaits one chunk at a time, and the engine walks each chunk without
 * yielding. One `await` per fifty thousand bars rather than one per bar is the whole reason a
 * backtest and a live session can share a kernel.
 *
 * Implementations live in `@tapedeck/data`. The core only needs the shape.
 */

import type { InstrumentSpec } from './instrument.ts';
import type { BarChunk, TickChunk } from './tape/chunk.ts';
import type { Duration, Timestamp } from './time/timestamp.ts';
import type { MarketEvent } from './events/events.ts';

export interface BarRequest {
  readonly symbol: string;
  readonly timeframe: Duration;
  readonly from: Timestamp;
  readonly to: Timestamp;
  /** Bars per yielded chunk. Providers may yield fewer at the end of a range. */
  readonly chunkSize?: number | undefined;
}

export interface TickRequest {
  readonly symbol: string;
  readonly from: Timestamp;
  readonly to: Timestamp;
  readonly chunkSize?: number | undefined;
}

export interface StreamRequest {
  readonly symbol: string;
  readonly timeframe?: Duration | undefined;
  /** Ask for bars, raw prints, or both. */
  readonly kinds: readonly ('bar' | 'tick')[];
}

export interface DataProvider {
  readonly id: string;
  /** Contract details, including the scales every other number depends on. */
  describe(symbol: string): Promise<InstrumentSpec>;
  bars(request: BarRequest): AsyncIterable<BarChunk>;
  ticks?(request: TickRequest): AsyncIterable<TickChunk>;
  /** Live data. Present only on providers that support paper trading. */
  stream?(request: StreamRequest): AsyncIterable<MarketEvent>;
}
