import { describe, expect, it } from 'vitest';
import {
  type BarChunk,
  ConfigError,
  MICROS_PER_HOUR,
  MICROS_PER_MILLI,
  MICROS_PER_MINUTE,
  MarketDataError,
  NotFoundError,
  UpstreamError,
  asDuration,
  asTimestamp,
  fromIso,
} from '@tapedeck/core';
import { BinanceDataProvider, binanceInterval, decimalsOf, trimZeros } from '../src/index.ts';

type Kline = [number, string, string, string, string, string, number];

interface StubCall {
  readonly url: string;
}

/**
 * A scripted `fetch`. Each entry is consumed in order, so a test can spell out exactly what the
 * venue answers — including the answers that are not JSON and the ones that say "slow down".
 */
function stubFetch(responses: (Response | (() => Response))[]) {
  const calls: StubCall[] = [];
  const remaining = [...responses];
  const doFetch = (url: string): Promise<Response> => {
    calls.push({ url });
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

const EXCHANGE_INFO = {
  symbols: [
    {
      symbol: 'BTCUSDT',
      status: 'TRADING',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01000000', minPrice: '0.01000000' },
        { filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000' },
      ],
    },
  ],
};

function kline(openMs: number, close: string, spanMs = 3_600_000): Kline {
  return [openMs, '100.00', '110.00', '90.00', close, '12.5', openMs + spanMs - 1];
}

function provider(responses: (Response | (() => Response))[], options = {}) {
  const stub = stubFetch(responses);
  return {
    stub,
    instance: new BinanceDataProvider({
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

describe('scale derivation', () => {
  it('reads significant decimals, not the venue padding', () => {
    expect(decimalsOf('0.01000000')).toBe(2);
    expect(decimalsOf('0.00001000')).toBe(5);
    expect(decimalsOf('1')).toBe(0);
    expect(decimalsOf('0.1')).toBe(1);
    expect(trimZeros('0.01000000')).toBe('0.01');
    expect(trimZeros('1.00000000')).toBe('1');
    expect(trimZeros('5')).toBe('5');
  });

  it('builds an instrument spec from the venue own filters', async () => {
    const { instance } = provider([json(EXCHANGE_INFO)]);
    expect(await instance.describe('BTCUSDT')).toEqual({
      symbol: 'BTCUSDT',
      venue: 'BINANCE',
      kind: 'spot',
      currency: 'USDT',
      priceExp: 2,
      qtyExp: 5,
      tickSize: '0.01',
      lotSize: '0.00001',
      pointValue: '1',
      accounting: 'cash',
    });
  });

  it('asks the venue once and remembers the answer', async () => {
    const { instance, stub } = provider([json(EXCHANGE_INFO)]);
    await instance.describe('BTCUSDT');
    await instance.describe('BTCUSDT');
    expect(stub.calls).toHaveLength(1);
  });

  it('reports an unlisted symbol as not found', async () => {
    const { instance } = provider([json({ symbols: [] })]);
    await expect(instance.describe('NOPE')).rejects.toThrow(NotFoundError);
  });

  it('rejects a response that does not have the shape it claims', async () => {
    const { instance } = provider([json({ unexpected: true })]);
    await expect(instance.describe('BTCUSDT')).rejects.toThrow(MarketDataError);
  });

  it('rejects a symbol whose filters omit the tick size', async () => {
    const { instance } = provider([
      json({ symbols: [{ ...EXCHANGE_INFO.symbols[0], filters: [] }] }),
    ]);
    await expect(instance.describe('BTCUSDT')).rejects.toThrow(/did not report tickSize/);
  });
});

describe('intervals', () => {
  it('maps the durations the venue publishes', () => {
    expect(binanceInterval(asDuration(MICROS_PER_MINUTE))).toBe('1m');
    expect(binanceInterval(asDuration(MICROS_PER_HOUR))).toBe('1h');
    expect(binanceInterval(asDuration(4 * MICROS_PER_HOUR))).toBe('4h');
  });

  it('refuses one it does not', () => {
    expect(() => binanceInterval(asDuration(7 * MICROS_PER_MINUTE))).toThrow(ConfigError);
  });
});

describe('candles', () => {
  const hourMs = 3_600_000;
  const from = fromIso('2026-01-01T00:00:00.000Z');
  const fromMs = from / MICROS_PER_MILLI;

  it('converts price strings into exact fixed-point integers', async () => {
    const { instance } = provider([
      json(EXCHANGE_INFO),
      json([
        [fromMs, '70000.12', '70500.99', '69000.01', '70123.45', '12.34567', fromMs + hourMs - 1],
      ]),
    ]);
    const [chunk] = await collect(
      instance.bars({
        symbol: 'BTCUSDT',
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
    expect(chunk?.volume[0]).toBe(1_234_567);
    // The venue's close time is inclusive; the engine's interval is half-open.
    expect(chunk?.openTs[0]).toBe(from);
    expect(chunk?.closeTs[0]).toBe(from + MICROS_PER_HOUR);
  });

  it('pages until the venue stops filling a page', async () => {
    const { instance, stub } = provider(
      [
        json(EXCHANGE_INFO),
        json([kline(fromMs, '100.00'), kline(fromMs + hourMs, '101.00')]),
        json([kline(fromMs + 2 * hourMs, '102.00'), kline(fromMs + 3 * hourMs, '103.00')]),
        json([kline(fromMs + 4 * hourMs, '104.00')]),
      ],
      { limit: 2 },
    );

    const chunks = await collect(
      instance.bars({
        symbol: 'BTCUSDT',
        timeframe: asDuration(MICROS_PER_HOUR),
        from,
        to: asTimestamp(from + 10 * MICROS_PER_HOUR),
      }),
    );

    const total = chunks.reduce((sum, chunk) => sum + chunk.count, 0);
    expect(total).toBe(5);
    expect(stub.calls).toHaveLength(4);
    expect(stub.calls[1]?.url).toContain('limit=2');
  });

  it('drops a candle that has not finished forming', async () => {
    const { instance } = provider([
      json(EXCHANGE_INFO),
      json([
        kline(fromMs, '100.00'),
        // This one closes after the requested end: it is still forming.
        kline(fromMs + hourMs, '101.00'),
      ]),
    ]);

    const [chunk] = await collect(
      instance.bars({
        symbol: 'BTCUSDT',
        timeframe: asDuration(MICROS_PER_HOUR),
        from,
        to: asTimestamp(from + MICROS_PER_HOUR),
      }),
    );
    expect(chunk?.count).toBe(1);
    expect(chunk?.close[0]).toBe(10_000);
  });

  it('splits its output at the requested chunk size', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => kline(fromMs + i * hourMs, '100.00'));
    const { instance } = provider([json(EXCHANGE_INFO), json(rows)]);

    const chunks = await collect(
      instance.bars({
        symbol: 'BTCUSDT',
        timeframe: asDuration(MICROS_PER_HOUR),
        from,
        to: asTimestamp(from + 10 * MICROS_PER_HOUR),
        chunkSize: 2,
      }),
    );
    expect(chunks.map((chunk) => chunk.count)).toEqual([2, 2, 1]);
  });

  it('stops on an empty page instead of looping', async () => {
    const { instance } = provider([json(EXCHANGE_INFO), json([])]);
    const chunks = await collect(
      instance.bars({
        symbol: 'BTCUSDT',
        timeframe: asDuration(MICROS_PER_HOUR),
        from,
        to: asTimestamp(from + 1_000 * MICROS_PER_HOUR),
      }),
    );
    expect(chunks).toHaveLength(0);
  });

  it('rejects a malformed klines payload', async () => {
    const { instance } = provider([json(EXCHANGE_INFO), json([['not', 'a', 'kline']])]);
    await expect(
      collect(
        instance.bars({
          symbol: 'BTCUSDT',
          timeframe: asDuration(MICROS_PER_HOUR),
          from,
          to: asTimestamp(from + MICROS_PER_HOUR),
        }),
      ),
    ).rejects.toThrow(MarketDataError);
  });
});

describe('rate limiting and failure', () => {
  it('waits and retries when the venue asks it to slow down', async () => {
    const waits: number[] = [];
    const stub = stubFetch([
      new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }),
      json(EXCHANGE_INFO),
    ]);
    const instance = new BinanceDataProvider({
      fetch: stub.doFetch,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });

    await expect(instance.describe('BTCUSDT')).resolves.toMatchObject({ symbol: 'BTCUSDT' });
    // Retry-After is in seconds, and ignoring it is how an address earns a ban.
    expect(waits).toEqual([2_000]);
  });

  it('backs off exponentially when no Retry-After is offered', async () => {
    const waits: number[] = [];
    const stub = stubFetch([
      new Response('busy', { status: 503 }),
      new Response('busy', { status: 503 }),
      json(EXCHANGE_INFO),
    ]);
    const instance = new BinanceDataProvider({
      fetch: stub.doFetch,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });

    await instance.describe('BTCUSDT');
    expect(waits).toEqual([500, 1_000]);
  });

  it('gives up after the configured number of attempts', async () => {
    const stub = stubFetch([
      new Response('busy', { status: 503 }),
      new Response('busy', { status: 503 }),
    ]);
    const instance = new BinanceDataProvider({
      fetch: stub.doFetch,
      sleep: () => Promise.resolve(),
      maxAttempts: 2,
    });

    await expect(instance.describe('BTCUSDT')).rejects.toThrow(UpstreamError);
    expect(stub.calls).toHaveLength(2);
  });

  it('does not retry a status that will never succeed', async () => {
    const stub = stubFetch([new Response('bad symbol', { status: 400 })]);
    const instance = new BinanceDataProvider({
      fetch: stub.doFetch,
      sleep: () => Promise.resolve(),
    });
    await expect(instance.describe('NOPE')).rejects.toThrow(/status 400/);
    expect(stub.calls).toHaveLength(1);
  });

  it('reports a non-JSON body as an upstream failure', async () => {
    const stub = stubFetch([new Response('<html>maintenance</html>', { status: 200 })]);
    const instance = new BinanceDataProvider({
      fetch: stub.doFetch,
      sleep: () => Promise.resolve(),
    });
    await expect(instance.describe('BTCUSDT')).rejects.toThrow(/not JSON/);
  });
});
