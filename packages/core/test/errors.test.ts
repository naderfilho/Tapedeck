import { describe, expect, it } from 'vitest';
import {
  type OrderStatus,
  ConfigError,
  ErrorCode,
  IllegalStateError,
  InternalError,
  MarketDataError,
  NotFoundError,
  NullStore,
  OrderError,
  PrecisionError,
  STRICT,
  TapedeckError,
  isOrderLive,
  isTerminalStatus,
} from '@tapedeck/core';

describe('typed errors', () => {
  const cases = [
    [new ConfigError('bad config', { field: 'seed' }), ErrorCode.InvalidConfig],
    [new MarketDataError('bad bar'), ErrorCode.InvalidMarketData],
    [new OrderError('bad order'), ErrorCode.InvalidOrder],
    [new PrecisionError('overflow'), ErrorCode.PrecisionLost],
    [new NotFoundError('missing'), ErrorCode.NotFound],
    [new IllegalStateError('too late'), ErrorCode.IllegalState],
    [new InternalError('bug'), ErrorCode.Internal],
  ] as const;

  it('carries a stable machine-readable code', () => {
    for (const [error, code] of cases) {
      expect(error).toBeInstanceOf(TapedeckError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
    }
  });

  it('names itself after its own class, so a stack trace is readable', () => {
    expect(new ConfigError('x').name).toBe('ConfigError');
    expect(new PrecisionError('x').name).toBe('PrecisionError');
  });

  it('serialises to a fixed shape that can be diffed between runs', () => {
    const error = new ConfigError('bad config', { field: 'seed' });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'ConfigError',
      code: 'INVALID_CONFIG',
      message: 'bad config',
      details: { field: 'seed' },
    });
  });

  it('defaults details to an empty object rather than undefined', () => {
    expect(new NotFoundError('missing').details).toEqual({});
  });
});

describe('order status predicates', () => {
  const live: OrderStatus[] = ['pending', 'working', 'partially_filled'];
  const terminal: OrderStatus[] = ['filled', 'cancelled', 'rejected'];

  it('treats exactly the non-terminal statuses as live', () => {
    for (const status of live) {
      expect(isOrderLive(status)).toBe(true);
      expect(isTerminalStatus(status)).toBe(false);
    }
    for (const status of terminal) {
      expect(isOrderLive(status)).toBe(false);
      expect(isTerminalStatus(status)).toBe(true);
    }
  });
});

describe('strict mode', () => {
  it('is on under test, which is what makes the bar-view guard meaningful', () => {
    expect(STRICT).toBe(true);
  });
});

describe('NullStore', () => {
  it('accepts everything and remembers nothing, so persistence is never a special case', async () => {
    await expect(NullStore.runs.save('run-1', {} as never)).resolves.toBeUndefined();
    await expect(NullStore.runs.load('run-1')).resolves.toBeNull();
    await expect(NullStore.runs.list()).resolves.toEqual([]);
    await expect(NullStore.bars.get({} as never)).resolves.toBeNull();
    await expect(NullStore.bars.put({} as never, {} as never)).resolves.toBeUndefined();
    await expect(NullStore.bars.coverage('B3', 'WIN', 0 as never)).resolves.toEqual([]);
    await expect(NullStore.paper.snapshot({} as never)).resolves.toBeUndefined();
    await expect(NullStore.paper.appendFill('s', {} as never)).resolves.toBeUndefined();
    await expect(NullStore.paper.restore('s')).resolves.toBeNull();
    NullStore.close();
  });
});
