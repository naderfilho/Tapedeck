/**
 * Binance public market data.
 *
 * Read-only and unauthenticated: this provider talks to the public endpoints and nothing else. It
 * cannot place an order because it has no concept of a key, which is the property you want from a
 * repository whose paper-trading mode is meant to be safe to run (ADR-0011).
 *
 * Prices arrive from the venue as **strings**, and they stay strings until {@link parseFixed}
 * turns them into fixed-point integers. Passing them through `JSON.parse`'s number handling would
 * lose the exactness before anything had a chance to round it deliberately.
 *
 * `fetch` and `sleep` are injectable so the tests can exercise pagination, truncation and the
 * retry path without a network — a provider whose only test is "it worked once against the real
 * API" has no test.
 */

import { z } from 'zod';
import {
  type BarChunk,
  type BarRequest,
  type DataProvider,
  type Duration,
  type InstrumentId,
  type InstrumentSpec,
  type MarketStream,
  type MarketStreamHandler,
  type StreamRequest,
  BarChunkBuilder,
  ConfigError,
  MICROS_PER_DAY,
  MICROS_PER_HOUR,
  MICROS_PER_MILLI,
  MICROS_PER_MINUTE,
  MarketDataError,
  NotFoundError,
  UpstreamError,
  parseFixed,
} from '@tapedeck/core';
import { BinanceStream } from './binance-stream.ts';
import { decimalsOf, trimZeros } from './decimals.ts';

// Both were defined here first and are re-exported so the package's surface does not move.
export { decimalsOf, trimZeros };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface BinanceProviderOptions {
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Attempts per request, including the first. Defaults to 4. */
  readonly maxAttempts?: number | undefined;
  /** Klines per HTTP request. The venue caps this at 1000. */
  readonly limit?: number | undefined;
  /** Pause between successive pages, to stay well inside the venue's weight limits. */
  readonly requestDelayMs?: number | undefined;
}

const KlineSchema = z
  .tuple([
    z.number(), // open time, milliseconds
    z.string(), // open
    z.string(), // high
    z.string(), // low
    z.string(), // close
    z.string(), // base-asset volume
    z.number(), // close time, milliseconds
  ])
  .rest(z.unknown());

const KlinesSchema = z.array(KlineSchema);

const FilterSchema = z.looseObject({ filterType: z.string() });

const SymbolInfoSchema = z.looseObject({
  symbol: z.string(),
  status: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  filters: z.array(FilterSchema),
});

const ExchangeInfoSchema = z.looseObject({ symbols: z.array(SymbolInfoSchema) });

const INTERVALS: readonly (readonly [number, string])[] = [
  [MICROS_PER_MINUTE, '1m'],
  [3 * MICROS_PER_MINUTE, '3m'],
  [5 * MICROS_PER_MINUTE, '5m'],
  [15 * MICROS_PER_MINUTE, '15m'],
  [30 * MICROS_PER_MINUTE, '30m'],
  [MICROS_PER_HOUR, '1h'],
  [2 * MICROS_PER_HOUR, '2h'],
  [4 * MICROS_PER_HOUR, '4h'],
  [6 * MICROS_PER_HOUR, '6h'],
  [8 * MICROS_PER_HOUR, '8h'],
  [12 * MICROS_PER_HOUR, '12h'],
  [MICROS_PER_DAY, '1d'],
  [3 * MICROS_PER_DAY, '3d'],
  [7 * MICROS_PER_DAY, '1w'],
];

export function binanceInterval(timeframe: Duration): string {
  const match = INTERVALS.find(([micros]) => micros === timeframe);
  if (match === undefined) {
    throw new ConfigError(`Binance does not publish a ${String(timeframe)}us interval`, {
      timeframe,
      supported: INTERVALS.map(([, name]) => name),
    });
  }
  return match[1];
}

const RETRYABLE = new Set([408, 418, 429, 500, 502, 503, 504]);

export class BinanceDataProvider implements DataProvider {
  readonly id = 'binance';
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly limit: number;
  private readonly requestDelayMs: number;
  /** exchangeInfo is stable and rate-limited; fetch a symbol's scales once per process. */
  private readonly specs = new Map<string, InstrumentSpec>();

  constructor(options: BinanceProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.binance.com').replace(/\/+$/, '');
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.maxAttempts = options.maxAttempts ?? 4;
    this.limit = Math.min(options.limit ?? 1000, 1000);
    this.requestDelayMs = options.requestDelayMs ?? 250;
  }

  /** Builds an instrument spec from the venue's own filters, so no scale is guessed. */
  async describe(symbol: string): Promise<InstrumentSpec> {
    const cached = this.specs.get(symbol);
    if (cached !== undefined) return cached;
    const payload = await this.request(
      `${this.baseUrl}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`,
    );
    const parsed = ExchangeInfoSchema.safeParse(payload);
    if (!parsed.success) {
      throw new MarketDataError('exchangeInfo response did not match the expected shape', {
        issues: parsed.error.issues.slice(0, 5),
      });
    }
    const info = parsed.data.symbols[0];
    if (info === undefined) {
      throw new NotFoundError(`Binance does not list ${symbol}`, { symbol });
    }

    const priceFilter = info.filters.find((f) => f.filterType === 'PRICE_FILTER');
    const lotFilter = info.filters.find((f) => f.filterType === 'LOT_SIZE');
    const tickSize = readFilterField(priceFilter, 'tickSize', symbol);
    const stepSize = readFilterField(lotFilter, 'stepSize', symbol);

    const spec: InstrumentSpec = {
      symbol: info.symbol,
      venue: 'BINANCE',
      kind: 'spot',
      currency: info.quoteAsset,
      priceExp: decimalsOf(tickSize),
      qtyExp: decimalsOf(stepSize),
      tickSize: trimZeros(tickSize),
      lotSize: trimZeros(stepSize),
      pointValue: '1',
      accounting: 'cash',
    };
    this.specs.set(symbol, spec);
    return spec;
  }

  /**
   * Streams closed candles for a range.
   *
   * Candles whose close lies beyond the requested end are dropped rather than truncated: a bar
   * that has not finished forming is not a bar, and letting one through is a subtle way to hand a
   * strategy the future.
   */
  async *bars(request: BarRequest): AsyncIterable<BarChunk> {
    // The venue's own scales decide how its price strings become integers, so they are fetched
    // before the first candle rather than assumed.
    const instrument = await this.describe(request.symbol);
    const interval = binanceInterval(request.timeframe);
    const intervalMs = request.timeframe / MICROS_PER_MILLI;
    const chunkSize = request.chunkSize ?? 50_000;
    const toMs = Math.floor(request.to / MICROS_PER_MILLI);

    let cursorMs = Math.floor(request.from / MICROS_PER_MILLI);
    let builder = new BarChunkBuilder(0 as InstrumentId, request.timeframe, chunkSize);
    let firstPage = true;

    while (cursorMs < toMs) {
      if (!firstPage && this.requestDelayMs > 0) await this.sleep(this.requestDelayMs);
      firstPage = false;

      const url =
        `${this.baseUrl}/api/v3/klines?symbol=${encodeURIComponent(request.symbol)}` +
        `&interval=${interval}&startTime=${String(cursorMs)}&endTime=${String(toMs)}` +
        `&limit=${String(this.limit)}`;
      const parsed = KlinesSchema.safeParse(await this.request(url));
      if (!parsed.success) {
        throw new MarketDataError('klines response did not match the expected shape', {
          issues: parsed.error.issues.slice(0, 5),
        });
      }
      const rows = parsed.data;
      if (rows.length === 0) break;

      for (const row of rows) {
        const [openTime, open, high, low, close, volume, closeTime] = row;
        if (closeTime > toMs) continue;
        builder.push(
          openTime * MICROS_PER_MILLI,
          (closeTime + 1) * MICROS_PER_MILLI,
          parseFixed(open, instrument.priceExp),
          parseFixed(high, instrument.priceExp),
          parseFixed(low, instrument.priceExp),
          parseFixed(close, instrument.priceExp),
          parseFixed(volume, instrument.qtyExp),
        );
        if (builder.count >= chunkSize) {
          yield builder.build();
          builder = new BarChunkBuilder(0 as InstrumentId, request.timeframe, chunkSize);
        }
      }

      const lastOpen = rows[rows.length - 1]?.[0] ?? cursorMs;
      const next = lastOpen + intervalMs;
      // A page that did not advance would loop forever; the venue has given us all it has.
      if (next <= cursorMs || rows.length < this.limit) break;
      cursorMs = next;
    }

    if (builder.count > 0) yield builder.build();
  }

  /**
   * The live feed for the same symbol, through the same scales.
   *
   * Synchronous, and it fetches nothing: `MarketStream.start()` is where the spec is resolved and
   * the socket is opened. That keeps the contract callable from a place that has no `await`
   * available, and it keeps `describe` cached on this provider rather than duplicated.
   */
  stream(request: StreamRequest, handler: MarketStreamHandler): MarketStream {
    return new BinanceStream(
      {
        symbol: request.symbol,
        kinds: request.kinds,
        timeframe: request.timeframe,
        describe: (symbol: string) => this.describe(symbol),
      },
      handler,
    );
  }

  /**
   * One HTTP call, with backoff on the statuses the venue uses to say "slow down".
   *
   * `Retry-After` is honoured when present, because ignoring it is how an IP earns a ban.
   */
  private async request(url: string): Promise<unknown> {
    let lastStatus = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const response = await this.doFetch(url);
      if (response.ok) {
        try {
          return await response.json();
        } catch (cause: unknown) {
          throw new UpstreamError('Binance returned a body that is not JSON', {
            url,
            cause: String(cause),
          });
        }
      }

      lastStatus = response.status;
      if (!RETRYABLE.has(response.status) || attempt === this.maxAttempts) break;

      const retryAfter = Number(response.headers.get('retry-after') ?? '');
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 2 ** attempt * 250;
      await this.sleep(waitMs);
    }

    throw new UpstreamError(`Binance request failed with status ${String(lastStatus)}`, {
      url,
      status: lastStatus,
      attempts: this.maxAttempts,
    });
  }
}

function readFilterField(
  filter: Record<string, unknown> | undefined,
  field: string,
  symbol: string,
): string {
  const value = filter?.[field];
  if (typeof value !== 'string') {
    throw new MarketDataError(`Binance did not report ${field} for ${symbol}`, { symbol, field });
  }
  return value;
}
