/**
 * The default {@link Store}, on `node:sqlite`.
 *
 * No native dependency, no compiler on install, no prebuild matrix (ADR-0007). Node prints an
 * experimental warning for `node:sqlite`; the CLI silences it with
 * `--disable-warning=ExperimentalWarning`, and the module itself has been stable in practice.
 *
 * Three responsibilities, deliberately kept apart (ADR-0008):
 *
 * - **bars** — a cache of downloaded market data, stored as `.tape` blobs. Storing the same bytes
 *   the file format uses means the cache and a file on disk are the same thing, and neither can
 *   drift from the other.
 * - **runs** — finished backtests, written once, at the end.
 * - **paper** — live state, written as it happens, because a crash there loses something that
 *   cannot be recomputed.
 *
 * The interface is asynchronous and this implementation is not. That is on purpose: `node:sqlite`
 * is synchronous, and a store that lives behind a network — Postgres, S3 — would not be. Paying
 * for a promise here keeps the option open there.
 */

import { DatabaseSync } from 'node:sqlite';
import {
  type BarCache,
  type BarCacheEntry,
  type BarChunk,
  type BarQuery,
  type CachedBars,
  type Duration,
  type OrderFilledEvent,
  type PaperRepository,
  type PaperState,
  type RunRepository,
  type RunResult,
  type Store,
  type StoredRun,
  type Timestamp,
  asTimestamp,
  ConfigError,
  parseRunResult,
  serializeRunResult,
} from '@tapedeck/core';
import { decodeBarTape, encodeBarTape } from '@tapedeck/data';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bars (
  venue      TEXT    NOT NULL,
  symbol     TEXT    NOT NULL,
  timeframe  INTEGER NOT NULL,
  from_ts    INTEGER NOT NULL,
  to_ts      INTEGER NOT NULL,
  bar_count  INTEGER NOT NULL,
  tape       BLOB    NOT NULL,
  PRIMARY KEY (venue, symbol, timeframe, from_ts, to_ts)
);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT    PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  strategy_id TEXT    NOT NULL,
  result      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_created_at ON runs (created_at DESC);

CREATE TABLE IF NOT EXISTS paper_state (
  session_id TEXT    PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  state      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_fills (
  session_id TEXT    NOT NULL,
  fill_id    INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  fill       TEXT    NOT NULL,
  PRIMARY KEY (session_id, fill_id)
);
`;

export interface SqliteStoreOptions {
  /** Database file. `:memory:` keeps everything in process, which is what the tests use. */
  readonly path: string;
  /** Supplies `createdAt`. Injectable so tests do not depend on the wall clock. */
  readonly now?: (() => Timestamp) | undefined;
}

interface BarRow {
  readonly from_ts: number;
  readonly to_ts: number;
  readonly bar_count: number;
  readonly tape: Uint8Array;
}

interface RunRow {
  readonly id: string;
  readonly created_at: number;
  readonly result: string;
}

/** Index of the first bar whose open is at or after `ts`. Binary search over a sorted column. */
function lowerBound(column: Float64Array, count: number, ts: number): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((column[middle] ?? 0) < ts) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sliceChunk(chunk: BarChunk, start: number, end: number): BarChunk {
  return {
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
  };
}

export class SqliteStore implements Store {
  readonly bars: BarCache;
  readonly runs: RunRepository;
  readonly paper: PaperRepository;

  private readonly db: DatabaseSync;
  private readonly now: () => Timestamp;
  private closed = false;

  constructor(options: SqliteStoreOptions) {
    if (options.path === '') throw new ConfigError('store path must not be empty');
    this.db = new DatabaseSync(options.path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.now =
      options.now ??
      // An adapter may read the wall clock; the kernel may not (ADR-0006).
      ((): Timestamp => asTimestamp(Date.now() * 1_000));

    this.bars = this.createBarCache();
    this.runs = this.createRunRepository();
    this.paper = this.createPaperRepository();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private createBarCache(): BarCache {
    const select = this.db.prepare(
      `SELECT from_ts, to_ts, bar_count, tape FROM bars
       WHERE venue = ? AND symbol = ? AND timeframe = ? AND from_ts <= ? AND to_ts >= ?
       ORDER BY bar_count ASC LIMIT 1`,
    );
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO bars (venue, symbol, timeframe, from_ts, to_ts, bar_count, tape)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const ranges = this.db.prepare(
      `SELECT from_ts, to_ts, bar_count, tape FROM bars
       WHERE venue = ? AND symbol = ? AND timeframe = ? ORDER BY from_ts ASC`,
    );

    return {
      get: (query: BarQuery): Promise<CachedBars | null> => {
        // Smallest covering range wins: it is the one that needs the least slicing.
        const row = select.get(query.venue, query.symbol, query.timeframe, query.from, query.to) as
          BarRow | undefined;
        if (row === undefined) return Promise.resolve(null);

        const file = decodeBarTape(row.tape);
        const { chunk } = file;
        const start = lowerBound(chunk.openTs, chunk.count, query.from);
        const end = lowerBound(chunk.closeTs, chunk.count, query.to + 1);
        return Promise.resolve({
          instrument: file.instrument,
          chunk: sliceChunk(chunk, start, Math.max(start, end)),
        });
      },

      put: (entry: BarCacheEntry): Promise<void> => {
        const tape = encodeBarTape({
          instrument: entry.instrument,
          chunk: entry.chunk,
          source: `${entry.query.venue}:${entry.query.symbol}`,
          createdBy: 'tapedeck/store',
        });
        insert.run(
          entry.query.venue,
          entry.query.symbol,
          entry.query.timeframe,
          entry.query.from,
          entry.query.to,
          entry.chunk.count,
          tape,
        );
        return Promise.resolve();
      },

      coverage: (
        venue: string,
        symbol: string,
        timeframe: Duration,
      ): Promise<readonly BarQuery[]> => {
        const rows = ranges.all(venue, symbol, timeframe) as unknown as BarRow[];
        return Promise.resolve(
          rows.map((row) => ({
            venue,
            symbol,
            timeframe,
            from: asTimestamp(row.from_ts),
            to: asTimestamp(row.to_ts),
          })),
        );
      },
    };
  }

  private createRunRepository(): RunRepository {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO runs (id, created_at, strategy_id, result) VALUES (?, ?, ?, ?)',
    );
    const select = this.db.prepare('SELECT id, created_at, result FROM runs WHERE id = ?');
    const list = this.db.prepare(
      'SELECT id, created_at, result FROM runs ORDER BY created_at DESC, id DESC LIMIT ?',
    );

    return {
      save: (id: string, result: RunResult): Promise<void> => {
        insert.run(id, this.now(), result.config.strategyId, serializeRunResult(result));
        return Promise.resolve();
      },

      load: (id: string): Promise<StoredRun | null> => {
        const row = select.get(id) as RunRow | undefined;
        if (row === undefined) return Promise.resolve(null);
        return Promise.resolve({
          id: row.id,
          createdAt: asTimestamp(row.created_at),
          result: parseRunResult(row.result),
        });
      },

      list: (limit = 50): Promise<readonly { id: string; createdAt: Timestamp }[]> => {
        const rows = list.all(limit) as unknown as RunRow[];
        return Promise.resolve(
          rows.map((row) => ({ id: row.id, createdAt: asTimestamp(row.created_at) })),
        );
      },
    };
  }

  private createPaperRepository(): PaperRepository {
    const upsert = this.db.prepare(
      'INSERT OR REPLACE INTO paper_state (session_id, updated_at, state) VALUES (?, ?, ?)',
    );
    const select = this.db.prepare('SELECT state FROM paper_state WHERE session_id = ?');
    const appendFill = this.db.prepare(
      'INSERT OR REPLACE INTO paper_fills (session_id, fill_id, ts, fill) VALUES (?, ?, ?, ?)',
    );

    return {
      snapshot: (state: PaperState): Promise<void> => {
        upsert.run(state.sessionId, this.now(), JSON.stringify(state));
        return Promise.resolve();
      },

      appendFill: (sessionId: string, fill: OrderFilledEvent): Promise<void> => {
        appendFill.run(sessionId, fill.fillId, fill.ts, JSON.stringify(fill));
        return Promise.resolve();
      },

      restore: (sessionId: string): Promise<PaperState | null> => {
        const row = select.get(sessionId) as { state: string } | undefined;
        if (row === undefined) return Promise.resolve(null);
        return Promise.resolve(JSON.parse(row.state) as PaperState);
      },

      fills: (sessionId: string): Promise<readonly OrderFilledEvent[]> =>
        Promise.resolve(this.fillsFor(sessionId)),
    };
  }

  /** Fills recorded for a session, oldest first. Used when rebuilding state after a restart. */
  fillsFor(sessionId: string): readonly OrderFilledEvent[] {
    const rows = this.db
      .prepare('SELECT fill FROM paper_fills WHERE session_id = ? ORDER BY fill_id ASC')
      .all(sessionId) as unknown as { fill: string }[];
    return rows.map((row) => JSON.parse(row.fill) as OrderFilledEvent);
  }
}

/** Opens a store at `path`, creating the schema when the file is new. */
export function openStore(path: string, options: Omit<SqliteStoreOptions, 'path'> = {}): Store {
  return new SqliteStore({ path, ...options });
}
