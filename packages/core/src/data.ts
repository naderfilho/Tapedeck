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

/** What a live stream tells its owner about itself, as opposed to about the market. */
export type StreamStatus =
  | { readonly kind: 'connecting'; readonly attempt: number }
  | { readonly kind: 'connected'; readonly url: string }
  | { readonly kind: 'disconnected'; readonly reason: string }
  /**
   * The stream was away and came back. Whatever printed while it was gone is gone: a paper session
   * that quietly resumes is a session claiming to have seen a market it did not see.
   */
  | { readonly kind: 'gap'; readonly sinceMicros: number }
  | { readonly kind: 'closed' };

/**
 * Where a live stream delivers what it received.
 *
 * Push, not pull, and the reason is backpressure. An `AsyncIterable` of market events makes the
 * consumer look tidy and hides the only question that matters live — what happens when the
 * strategy is slower than the market — inside an invisible buffer. A handler that enqueues, plus
 * a queue whose depth is a number the session reports, puts that question back on the surface
 * (ADR-0003, ADR-0014).
 *
 * Chunks rather than single events, so the live path hands the engine exactly what the backtest
 * path hands it. A live chunk is usually one bar or one print long; that is a size, not a
 * different shape.
 */
export interface MarketStreamHandler {
  onBars(chunk: BarChunk): void;
  onTicks(chunk: TickChunk): void;
  onStatus(status: StreamStatus): void;
}

export interface MarketStream {
  /** Resolves once the first connection is established. */
  start(): Promise<void>;
  /** Stops reconnecting and closes the socket. Safe to call twice. */
  stop(): Promise<void>;
}

export interface DataProvider {
  readonly id: string;
  /** Contract details, including the scales every other number depends on. */
  describe(symbol: string): Promise<InstrumentSpec>;
  bars(request: BarRequest): AsyncIterable<BarChunk>;
  ticks?(request: TickRequest): AsyncIterable<TickChunk>;
  /** Live data. Present only on providers that support paper trading. */
  stream?(request: StreamRequest, handler: MarketStreamHandler): MarketStream;
}
