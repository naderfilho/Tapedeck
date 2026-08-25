import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BarChunk,
  type InstrumentId,
  type OrderFilledEvent,
  type PaperState,
  type RunResult,
  type Store,
  type Timestamp,
  BarChunkBuilder,
  Engine,
  EventKind,
  INSTRUMENTS,
  MICROS_PER_HOUR,
  asDuration,
  asMoney,
  asPrice,
  asQty,
  asTimestamp,
  ConfigError,
  serializeRunResult,
} from '@tapedeck/core';
import { SqliteStore, openStore } from '../src/index.ts';

const ZERO = 0 as InstrumentId;
const SPEC = INSTRUMENTS.BTCUSDT;

const stores: Store[] = [];
function store(now?: () => Timestamp): SqliteStore {
  const instance = new SqliteStore({ path: ':memory:', now });
  stores.push(instance);
  return instance;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function bars(count: number, startTs = 0): BarChunk {
  const builder = new BarChunkBuilder(ZERO, asDuration(MICROS_PER_HOUR), Math.max(1, count));
  for (let i = 0; i < count; i++) {
    const openTs = startTs + i * MICROS_PER_HOUR;
    const price = 7_000_000 + i * 100;
    builder.push(
      openTs,
      openTs + MICROS_PER_HOUR,
      price,
      price + 50,
      price - 50,
      price + 10,
      1_000,
    );
  }
  return builder.build();
}

function runResult(): RunResult {
  const engine = new Engine({
    instruments: [SPEC],
    strategy: () => ({ id: 'stored', onInit: () => undefined }),
    params: {},
    initialCash: '1000',
    seed: 3,
  });
  engine.feedBars(bars(10));
  return engine.finish();
}

describe('bar cache', () => {
  it('returns nothing for a range it has never seen', async () => {
    const instance = store();
    await expect(
      instance.bars.get({
        venue: 'BINANCE',
        symbol: 'BTCUSDT',
        timeframe: asDuration(MICROS_PER_HOUR),
        from: asTimestamp(0),
        to: asTimestamp(MICROS_PER_HOUR),
      }),
    ).resolves.toBeNull();
  });

  it('round-trips bars through the same format the files use', async () => {
    const instance = store();
    const chunk = bars(100);
    const query = {
      venue: 'BINANCE',
      symbol: 'BTCUSDT',
      timeframe: asDuration(MICROS_PER_HOUR),
      from: asTimestamp(0),
      to: asTimestamp(100 * MICROS_PER_HOUR),
    };

    await instance.bars.put({ query, instrument: SPEC, chunk });
    const cached = await instance.bars.get(query);

    expect(cached?.instrument).toEqual(SPEC);
    expect(cached?.chunk.count).toBe(100);
    expect(Array.from(cached?.chunk.close ?? [])).toEqual(Array.from(chunk.close));
  });

  it('slices a stored range down to the range that was asked for', async () => {
    const instance = store();
    const query = {
      venue: 'BINANCE',
      symbol: 'BTCUSDT',
      timeframe: asDuration(MICROS_PER_HOUR),
      from: asTimestamp(0),
      to: asTimestamp(100 * MICROS_PER_HOUR),
    };
    await instance.bars.put({ query, instrument: SPEC, chunk: bars(100) });

    const narrow = await instance.bars.get({
      ...query,
      from: asTimestamp(10 * MICROS_PER_HOUR),
      to: asTimestamp(20 * MICROS_PER_HOUR),
    });

    expect(narrow?.chunk.count).toBe(10);
    expect(narrow?.chunk.openTs[0]).toBe(10 * MICROS_PER_HOUR);
    expect(narrow?.chunk.closeTs[9]).toBe(20 * MICROS_PER_HOUR);
  });

  it('does not answer with a range that only partly covers the request', async () => {
    const instance = store();
    const timeframe = asDuration(MICROS_PER_HOUR);
    await instance.bars.put({
      query: {
        venue: 'BINANCE',
        symbol: 'BTCUSDT',
        timeframe,
        from: asTimestamp(0),
        to: asTimestamp(50 * MICROS_PER_HOUR),
      },
      instrument: SPEC,
      chunk: bars(50),
    });

    // Half of this range was never downloaded; returning the half we have would silently shorten
    // the backtest.
    await expect(
      instance.bars.get({
        venue: 'BINANCE',
        symbol: 'BTCUSDT',
        timeframe,
        from: asTimestamp(0),
        to: asTimestamp(100 * MICROS_PER_HOUR),
      }),
    ).resolves.toBeNull();
  });

  it('reports what it holds so a fetch can ask only for the gaps', async () => {
    const instance = store();
    const timeframe = asDuration(MICROS_PER_HOUR);
    const base = { venue: 'BINANCE', symbol: 'BTCUSDT', timeframe };

    await instance.bars.put({
      query: { ...base, from: asTimestamp(0), to: asTimestamp(10 * MICROS_PER_HOUR) },
      instrument: SPEC,
      chunk: bars(10),
    });
    await instance.bars.put({
      query: {
        ...base,
        from: asTimestamp(20 * MICROS_PER_HOUR),
        to: asTimestamp(30 * MICROS_PER_HOUR),
      },
      instrument: SPEC,
      chunk: bars(10, 20 * MICROS_PER_HOUR),
    });

    const coverage = await instance.bars.coverage('BINANCE', 'BTCUSDT', timeframe);
    expect(coverage.map((range) => [range.from, range.to])).toEqual([
      [0, 10 * MICROS_PER_HOUR],
      [20 * MICROS_PER_HOUR, 30 * MICROS_PER_HOUR],
    ]);
    expect(await instance.bars.coverage('B3', 'WIN', timeframe)).toEqual([]);
  });

  it('overwrites a range rather than duplicating it', async () => {
    const instance = store();
    const query = {
      venue: 'BINANCE',
      symbol: 'BTCUSDT',
      timeframe: asDuration(MICROS_PER_HOUR),
      from: asTimestamp(0),
      to: asTimestamp(10 * MICROS_PER_HOUR),
    };
    await instance.bars.put({ query, instrument: SPEC, chunk: bars(10) });
    await instance.bars.put({ query, instrument: SPEC, chunk: bars(10) });
    expect(await instance.bars.coverage('BINANCE', 'BTCUSDT', query.timeframe)).toHaveLength(1);
  });
});

describe('run history', () => {
  it('stores a result and gives it back unchanged', async () => {
    const instance = store(() => asTimestamp(1_700_000_000_000_000));
    const original = runResult();

    await instance.runs.save('run-1', original);
    const stored = await instance.runs.load('run-1');

    expect(stored?.id).toBe('run-1');
    expect(stored?.createdAt).toBe(1_700_000_000_000_000);
    // Byte-for-byte: a stored run and the run that produced it must be the same object.
    expect(serializeRunResult(stored?.result as RunResult)).toBe(serializeRunResult(original));
    expect(stored?.result.equityCurve.equity).toBeInstanceOf(Float64Array);
  });

  it('returns null for a run that was never saved', async () => {
    const instance = store();
    await expect(instance.runs.load('missing')).resolves.toBeNull();
  });

  it('lists the most recent runs first', async () => {
    let clock = 1_000;
    const instance = store(() => asTimestamp((clock += 1_000)));
    const result = runResult();

    await instance.runs.save('first', result);
    await instance.runs.save('second', result);
    await instance.runs.save('third', result);

    expect((await instance.runs.list()).map((row) => row.id)).toEqual(['third', 'second', 'first']);
    expect(await instance.runs.list(2)).toHaveLength(2);
  });
});

describe('paper-trading state', () => {
  const state: PaperState = {
    sessionId: 'session-1',
    instruments: [SPEC],
    openOrders: [],
    positions: [],
    lastEventTs: asTimestamp(42),
  };

  function fill(id: number): OrderFilledEvent {
    return {
      kind: EventKind.OrderFilled,
      ts: asTimestamp(id * 1_000),
      seq: id,
      orderId: id as never,
      fillId: id as never,
      instrumentId: ZERO,
      side: 'buy',
      price: asPrice(7_000_000),
      qty: asQty(1),
      leavesQty: asQty(0),
      commission: asMoney(1),
      slippage: asMoney(0),
      liquidity: 'taker',
      tag: null,
    };
  }

  it('survives a restart by round-tripping the snapshot', async () => {
    const instance = store();
    await instance.paper.snapshot(state);
    expect(await instance.paper.restore('session-1')).toEqual(state);
  });

  it('keeps only the latest snapshot per session', async () => {
    const instance = store();
    await instance.paper.snapshot(state);
    await instance.paper.snapshot({ ...state, lastEventTs: asTimestamp(99) });
    expect((await instance.paper.restore('session-1'))?.lastEventTs).toBe(99);
  });

  it('appends fills in order and replays them', async () => {
    const instance = store();
    await instance.paper.appendFill('session-1', fill(1));
    await instance.paper.appendFill('session-1', fill(2));
    await instance.paper.appendFill('other', fill(3));

    expect(instance.fillsFor('session-1').map((event) => event.fillId)).toEqual([1, 2]);
    expect(instance.fillsFor('other')).toHaveLength(1);
    expect(instance.fillsFor('nobody')).toHaveLength(0);
  });

  it('returns null for an unknown session', async () => {
    const instance = store();
    await expect(instance.paper.restore('nope')).resolves.toBeNull();
  });
});

describe('lifecycle', () => {
  it('creates its schema in a file that did not exist', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tapedeck-store-'));
    try {
      const path = join(directory, 'runs.sqlite');
      const first = openStore(path);
      await first.runs.save('run-1', runResult());
      first.close();

      // Reopening reads the same file, which is the entire point of persistence.
      const second = openStore(path);
      expect(await second.runs.load('run-1')).not.toBeNull();
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('tolerates being closed twice', () => {
    const instance = new SqliteStore({ path: ':memory:' });
    instance.close();
    expect(() => {
      instance.close();
    }).not.toThrow();
  });

  it('refuses an empty path', () => {
    expect(() => new SqliteStore({ path: '' })).toThrow(ConfigError);
  });
});
