/**
 * Persistence contracts (ADR-0008).
 *
 * The core declares them and never implements them. A backtest runs entirely in memory and writes
 * once, at the end, if a store was injected; paper trading writes incrementally, because a crash
 * there loses state that cannot be recomputed.
 *
 * The default is {@link NullStore}, so the engine never has to branch on whether persistence
 * exists.
 */

import type { BarChunk } from './tape/chunk.ts';
import type { InstrumentSpec } from './instrument.ts';
import type { Duration, Timestamp } from './time/timestamp.ts';
import type { RunResult } from './engine/result.ts';
import type { OrderFilledEvent } from './events/events.ts';
import type { OrderSnapshot } from './execution/order.ts';
import type { MoneyInt } from './math/fixed.ts';
import type { PositionView } from './portfolio/portfolio.ts';

export interface BarQuery {
  readonly venue: string;
  readonly symbol: string;
  readonly timeframe: Duration;
  readonly from: Timestamp;
  readonly to: Timestamp;
}

/**
 * What a cache hands back: the bars *and* the scales they were stored at.
 *
 * Returning bars without the instrument would be returning integers without units — the same
 * `7000012` is 70,000.12 or 0.07000012 depending on a number the caller has no way to guess.
 */
export interface CachedBars {
  readonly instrument: InstrumentSpec;
  readonly chunk: BarChunk;
}

export interface BarCacheEntry {
  readonly query: BarQuery;
  readonly instrument: InstrumentSpec;
  readonly chunk: BarChunk;
}

/** Cache of downloaded market data, keyed by instrument and time range. */
export interface BarCache {
  /** Returns bars covering the whole query, or `null` when no stored range contains it. */
  get(query: BarQuery): Promise<CachedBars | null>;
  put(entry: BarCacheEntry): Promise<void>;
  /** Ranges already cached for a symbol, so a fetch can ask only for the gaps. */
  coverage(venue: string, symbol: string, timeframe: Duration): Promise<readonly BarQuery[]>;
}

export interface StoredRun {
  readonly id: string;
  readonly createdAt: Timestamp;
  readonly result: RunResult;
}

export interface RunRepository {
  save(id: string, result: RunResult): Promise<void>;
  load(id: string): Promise<StoredRun | null>;
  list(limit?: number): Promise<readonly { id: string; createdAt: Timestamp }[]>;
}

/**
 * The counters that make a restarted session continue rather than start again.
 *
 * Restoring positions without them would hand the new session order and fill ids it has already
 * used: `paper_fills` is keyed by `(sessionId, fillId)`, so the second fill number 1 would
 * overwrite the first and the audit trail would silently lose a trade.
 */
export interface PaperCounters {
  readonly nextOrderId: number;
  readonly nextFillId: number;
  /** The event sequence that gives every event its place in the total order. */
  readonly seq: number;
}

/**
 * Live state that must survive a restart.
 *
 * This is the whole account, not a hint about it: cash, the cost basis of every open position, the
 * resting orders and the counters. A session that came back from this snapshot and a session that
 * never died must be indistinguishable, which is why the cash balance is stored rather than
 * recomputed — recomputing it means replaying every fill and trusting that the replay charges the
 * same commission the venue did.
 */
export interface PaperState {
  readonly sessionId: string;
  readonly strategyId: string;
  readonly instruments: readonly InstrumentSpec[];
  readonly openOrders: readonly OrderSnapshot[];
  readonly positions: readonly PositionView[];
  readonly cash: MoneyInt;
  readonly initialCash: MoneyInt;
  /** Timestamp of the last market event applied. A restored session refuses anything older. */
  readonly lastEventTs: Timestamp;
  readonly counters: PaperCounters;
}

export interface PaperRepository {
  snapshot(state: PaperState): Promise<void>;
  appendFill(sessionId: string, fill: OrderFilledEvent): Promise<void>;
  restore(sessionId: string): Promise<PaperState | null>;
  /** Every fill recorded for a session, oldest first. The audit trail behind the snapshot. */
  fills(sessionId: string): Promise<readonly OrderFilledEvent[]>;
}

export interface Store {
  readonly bars: BarCache;
  readonly runs: RunRepository;
  readonly paper: PaperRepository;
  close(): void;
}

/** Does nothing, successfully. The default, so persistence is never a special case. */
export const NullStore: Store = {
  bars: {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
    coverage: () => Promise.resolve([]),
  },
  runs: {
    save: () => Promise.resolve(),
    load: () => Promise.resolve(null),
    list: () => Promise.resolve([]),
  },
  paper: {
    snapshot: () => Promise.resolve(),
    appendFill: () => Promise.resolve(),
    restore: () => Promise.resolve(null),
    fills: () => Promise.resolve([]),
  },
  close: () => undefined,
};
