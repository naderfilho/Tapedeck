import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type BarChunk,
  ConfigError,
  MICROS_PER_HOUR,
  MICROS_PER_MINUTE,
  MICROS_PER_SECOND,
  MarketDataError,
  NotFoundError,
  UpstreamError,
  asDuration,
  asTimestamp,
  fromIso,
  parseFixed,
  validateBarChunk,
} from '@tapedeck/core';
import { CoinbaseDataProvider, coinbaseGranularity, decimalString } from '../src/index.ts';

/** `[time, low, high, open, close, volume]` — the venue's own column order. */
type Candle = [number, number, number, number, number, number];

function stubFetch(responses: (Response | (() => Response))[]) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const remaining = [...responses];
  const doFetch = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = remaining.shift();
    if (next === undefined) throw new Error(`unexpected request to ${url}`);
    return Promise.resolve(typeof next === 'function' ? next() : next);
  };
  return { doFetch, calls };
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const PRODUCT = {
  id: 'BTC-USD',
  base_currency: 'BTC',
  quote_currency: 'USD',
  quote_increment: '0.01',
  base_increment: '0.00000001',
  status: 'online',
  trading_disabled: false,
};

function provider(responses: (Response | (() => Response))[], options = {}) {
  const stub = stubFetch(responses);
  return {
    stub,
    instance: new CoinbaseDataProvider({
      fetch: stub.doFetch,
      sleep: () => Promise.resolve(),
      requestDelayMs: 0,
      ...options,
    }),
  };
}

async function collect(source: AsyncIterable<BarChunk>): Promise<BarChunk[]> {
  const chunks: BarChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

describe('decimalString', () => {
  it('writes a double the shortest way that reads back as the same double', () => {
    expect(decimalString(113808.32)).toBe('113808.32');
    expect(decimalString(0)).toBe('0');
    expect(decimalString(-12.5)).toBe('-12.5');
  });

  it('writes out the exponents a fixed-point parser cannot read', () => {
    // A coin quoted at a hundred-millionth of a dollar arrives from JSON.parse as 1.2e-8, which
    // parseFixed rejects. This is the only reason the helper exists.
    expect(decimalString(1.2e-8)).toBe('0.000000012');
    expect(decimalString(5e-7)).toBe('0.0000005');
    expect(decimalString(1.5e21)).toBe('1500000000000000000000');
  });

  it('round-trips every double it is given', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (value) => {
        const text = decimalString(value);
        expect(text).not.toMatch(/e/i);
        // Loose equality on purpose: negative zero writes as '0' and reads back as positive zero,
        // which is the only value this cannot round-trip and the only one no venue ever quotes.
        expect(Number(text) === value).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('produces something the fixed-point parser accepts, at the scales a venue quotes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 ** 12 }),
        fc.integer({ min: 0, max: 8 }),
        (units, exp) => {
          const value = units / 10 ** exp;
          expect(parseFixed(decimalString(value), exp)).toBe(Math.round(value * 10 ** exp));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('refuses what cannot be written at all', () => {
    expect(() => decimalString(Number.NaN)).toThrow(RangeError);
    expect(() => decimalString(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('granularities', () => {
  it('maps the candle sizes the venue publishes', () => {
    expect(coinbaseGranularity(asDuration(MICROS_PER_MINUTE))).toBe(60);
    expect(coinbaseGranularity(asDuration(MICROS_PER_HOUR))).toBe(3_600);
  });

  it('refuses one it does not, rather than asking for a candle that comes back wrong', () => {
    // Coinbase answers an unsupported granularity with an error, but a provider that only finds
    // out over the network fails halfway through a download instead of at configuration time.
    expect(() => coinbaseGranularity(asDuration(4 * MICROS_PER_HOUR))).toThrow(ConfigError);
  });
});

describe('products', () => {
  it('builds an instrument spec from the product increments', async () => {
    const { instance } = provider([json(PRODUCT)]);
    expect(await instance.describe('BTC-USD')).toEqual({
      symbol: 'BTC-USD',
      venue: 'COINBASE',
      kind: 'spot',
      currency: 'USD',
      priceExp: 2,
      qtyExp: 8,
      tickSize: '0.01',
      lotSize: '0.00000001',
      pointValue: '1',
      accounting: 'cash',
    });
  });

  it('asks the venue once and remembers the answer', async () => {
    const { instance, stub } = provider([json(PRODUCT)]);
    await instance.describe('BTC-USD');
    await instance.describe('BTC-USD');
    expect(stub.calls).toHaveLength(1);
  });

  it('sends a user agent, which the venue answers 403 without', async () => {
    const { instance, stub } = provider([json(PRODUCT)]);
    await instance.describe('BTC-USD');
    const headers = stub.calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.['user-agent']).toBeTruthy();
  });

  it('refuses a product the venue has delisted', async () => {
    const { instance } = provider([json({ ...PRODUCT, status: 'delisted' })]);
    await expect(instance.describe('OLD-USD')).rejects.toThrow(NotFoundError);
  });

  it('rejects a response that does not have the shape it claims', async () => {
    const { instance } = provider([json({ unexpected: true })]);
    await expect(instance.describe('BTC-USD')).rejects.toThrow(MarketDataError);
  });

  it('reports an unknown product as not found rather than as an upstream failure', async () => {
    const { instance } = provider([json({ message: 'NotFound' }, { status: 404 })]);
    await expect(instance.describe('NOPE-USD')).rejects.toThrow(NotFoundError);
  });
});

describe('candles', () => {
  const from = fromIso('2026-01-01T00:00:00.000Z');
  const seconds = (hours: number): number => from / MICROS_PER_SECOND + hours * 3_600;

  /** A consistent candle: the low and the high straddle both the open and the close. */
  function candle(hour: number, close: number, open = close): Candle {
    const low = Math.min(open, close) - 1;
    const high = Math.max(open, close) + 1;
    return [seconds(hour), low, high, open, close, 12.34567891];
  }

  it('converts the venue numbers into exact fixed-point integers', async () => {
    const raw: Candle = [seconds(0), 69_000.01, 70_500.99, 70_000.12, 70_123.45, 12.34567891];
    const { instance } = provider([json(PRODUCT), json([raw])]);
    const [chunk] = await collect(
      instance.bars({
        symbol: 'BTC-USD',
        timeframe: asDuration(MICROS_PER_HOUR),
        from,
        to: asTimestamp(from + 2 * MICROS_PER_HOUR),
      }),
    );

    expect(chunk?.count).toBe(1);
    expect(chunk?.open[0]).toBe(7_000_012);
    expect(chunk?.high[0]).toBe(7_050_099);
    expect(chunk?.low[0]).toBe(6_900_001);
    expect(chunk?.close[0]).toBe(7_012_345);
    expect(chunk?.volume[0]).toBe(1_234_567_891);
    expect(chunk?.openTs[0]).toBe(from);
    expect(chunk?.closeTs[0]).toBe(from + MICROS_PER_HOUR);
  });

  it('sorts a page, because the venue answers newest first', async () => {
    const { instance } = provider([
      json(PRODUCT),
      json([candle(2, 102), candle(0, 100), candle(1, 101)]),
    ]);
    const [chunk] = await collect(
      instance.bars({
        symbol: 'BTC-USD',
        timeframe: asDuration(MICROS_PER_HOUR),
        from,
        to: asTimestamp(from + 3 * MICROS_PER_HOUR),
      }),
    );

    expect(Array.from(chunk?.close ?? [])).toEqual([100_00, 101_00, 102_00]);
    expect(() => {
      validateBarChunk(chunk as BarChunk);
    }).not.toThrow();
  });

  it('walks the window forward until the range is covered', async () => {
    // 300 candles per response is the venue's cap, so a range longer than that is several
    // requests whose windows must not overlap.
    const first = Array.from({ length: 300 }, (_, i) => candle(i, 100 + i));
    const second = Array.from({ length: 60 }, (_, i) => candle(300 + i, 400 + i));
    const { instance, stub } = provider([json(PRODUCT), json(first), json(second)]);

    const chunks = await collect(
      instance.bars({
        symbol: 'BTC-USD',
        timeframe: asDuration(MICROS_PER_HOUR),
        from,
        to: asTimestamp(from + 360 * MICROS_PER_HOUR),
      }),
    );

    const total = chunks.reduce((sum, chunk) => sum + chunk.count, 0);
    expect(total).toBe(360);
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls[1]?.url).toContain('granularity=3600');
  });

  it('drops a candle the range does not fully contain', async () => {
    // The bar opening at 02:00 closes at 03:00, past a range that ends at 02:00. Admitting it
    // would hand a strategy a bar from outside the window it asked for.
    const { instance } = provider([
      json(PRODUCT),
      json([candle(0, 100), candle(1, 101), candle(2, 102)]),
    ]);
    const [chunk] = await collect(
      instance.bars({
        symbol: 'BTC-USD',
        timeframe: asDuration(MICROS_PER_HOUR),
        from,
        to: asTimestamp(from + 2 * MICROS_PER_HOUR),
      }),
    );

    expect(chunk?.count).toBe(2);
  });

  it('never delivers the same bar twice, even when two windows overlap', async () => {
    // The venue treats `end` as inclusive of the bucket that starts on it. A page that repeats its
    // predecessor's last candle would otherwise put a bar into the tape twice, and a duplicated
    // bar is a bar the strategy trades twice.
    const first = Array.from({ length: 300 }, (_, i) => candle(i, 100 + i));
    const second = [candle(299, 399), candle(300, 400)];
    const { instance } = provider([json(PRODUCT), json(first), json(second)]);

    const chunks = await collect(
      instance.bars({
        symbol: 'BTC-USD',
        timeframe: asDuration(MICROS_PER_HOUR),
        from,
        to: asTimestamp(from + 400 * MICROS_PER_HOUR),
      }),
    );

    const opens = chunks.flatMap((chunk) => Array.from(chunk.openTs.slice(0, chunk.count)));
    expect(new Set(opens).size).toBe(opens.length);
  });

  it('leaves a gap where the venue printed nothing', async () => {
    // No trades in an hour means no candle at all, which is a fact about the market rather than a
    // hole to fill in. Interpolating one would invent a price nobody paid.
    const { instance } = provider([json(PRODUCT), json([candle(0, 100), candle(2, 102)])]);
    const [chunk] = await collect(
      instance.bars({
        symbol: 'BTC-USD',
        timeframe: asDuration(MICROS_PER_HOUR),
        from,
        to: asTimestamp(from + 3 * MICROS_PER_HOUR),
      }),
    );

    expect(chunk?.count).toBe(2);
    expect(chunk?.openTs[1]).toBe(from + 2 * MICROS_PER_HOUR);
  });

  it('retries a rate limit and gives up with the status attached', async () => {
    const { instance } = provider([
      json(PRODUCT),
      new Response('slow down', { status: 429 }),
      json([candle(0, 100)]),
    ]);
    const [chunk] = await collect(
      instance.bars({
        symbol: 'BTC-USD',
        timeframe: asDuration(MICROS_PER_HOUR),
        from,
        to: asTimestamp(from + MICROS_PER_HOUR),
      }),
    );
    expect(chunk?.count).toBe(1);

    const failing = provider([
      json(PRODUCT),
      ...Array.from({ length: 4 }, () => json([], { status: 503 })),
    ]);
    await expect(
      collect(
        failing.instance.bars({
          symbol: 'BTC-USD',
          timeframe: asDuration(MICROS_PER_HOUR),
          from,
          to: asTimestamp(from + MICROS_PER_HOUR),
        }),
      ),
    ).rejects.toThrow(UpstreamError);
  });

  it('rejects a candle response that does not have the shape it claims', async () => {
    const { instance } = provider([json(PRODUCT), json([['not', 'a', 'candle']])]);
    await expect(
      collect(
        instance.bars({
          symbol: 'BTC-USD',
          timeframe: asDuration(MICROS_PER_HOUR),
          from,
          to: asTimestamp(from + MICROS_PER_HOUR),
        }),
      ),
    ).rejects.toThrow(MarketDataError);
  });
});
