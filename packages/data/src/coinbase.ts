/**
 * Coinbase Exchange public market data.
 *
 * The second venue, and it is here for a reason that has nothing to do with wanting more symbols:
 * a strategy's result is a claim about a venue, not about an asset. Coinbase's entry fee tier is
 * six times Binance's, its book is a different depth, and its prices are quoted against dollars
 * rather than a stablecoin. Running one venue's tape under another's assumptions produces a report
 * about a market nobody traded in — so the tape and the fee schedule arrive together, and
 * `PRESETS.coinbaseExchange` exists next to `PRESETS.binanceSpot` rather than instead of it.
 *
 * Read-only and unauthenticated, like {@link BinanceDataProvider}: these endpoints need no key,
 * and a provider with no concept of one cannot place an order (ADR-0011).
 *
 * Historical bars only. There is no {@link DataProvider.stream} here, because paper trading is
 * driven by the Binance socket and claiming a live feed this file does not implement would be a
 * worse kind of missing than the absence.
 *
 * Two differences from Binance shape the code:
 *
 * - **Candles come back as JSON numbers, not strings.** By the time `JSON.parse` is done the
 *   decimal is already a double, so the string discipline the Binance provider keeps is not
 *   available here. {@link decimalString} converts without adding a second error, and the loss is
 *   documented rather than hidden.
 * - **Pages are windows, not cursors.** The endpoint takes `start`/`end` and caps a response at
 *   300 candles, so a year of hours is thirty requests that must be walked forward by time and
 *   sorted, because it answers newest-first.
 */

import { z } from 'zod';
import {
  type BarChunk,
  type BarRequest,
  type DataProvider,
  type Duration,
  type InstrumentId,
  type InstrumentSpec,
  BarChunkBuilder,
  ConfigError,
  MICROS_PER_DAY,
  MICROS_PER_HOUR,
  MICROS_PER_MINUTE,
  MICROS_PER_SECOND,
  MarketDataError,
  NotFoundError,
  UpstreamError,
  parseFixed,
} from '@tapedeck/core';
import { decimalString, decimalsOf, trimZeros } from './decimals.ts';
import type { FetchLike } from './binance.ts';

export interface CoinbaseProviderOptions {
  readonly baseUrl?: string | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Attempts per request, including the first. Defaults to 4. */
  readonly maxAttempts?: number | undefined;
  /** Pause between successive pages. The public endpoints allow ten requests a second per IP. */
  readonly requestDelayMs?: number | undefined;
}

/** `[time, low, high, open, close, volume]`, seconds and numbers, newest first. */
const CandleSchema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);

const CandlesSchema = z.array(CandleSchema);

const ProductSchema = z.looseObject({
  id: z.string(),
  base_currency: z.string(),
  quote_currency: z.string(),
  quote_increment: z.string(),
  base_increment: z.string(),
  status: z.string(),
  trading_disabled: z.boolean().optional(),
});

/** The granularities the venue publishes, in microseconds. It offers no others. */
const GRANULARITIES: readonly (readonly [number, number])[] = [
  [MICROS_PER_MINUTE, 60],
  [5 * MICROS_PER_MINUTE, 300],
  [15 * MICROS_PER_MINUTE, 900],
  [MICROS_PER_HOUR, 3_600],
  [6 * MICROS_PER_HOUR, 21_600],
  [MICROS_PER_DAY, 86_400],
];

/** Candles per response. The venue's own cap; asking for more silently returns this many. */
const PAGE_CANDLES = 300;

export function coinbaseGranularity(timeframe: Duration): number {
  const match = GRANULARITIES.find(([micros]) => micros === timeframe);
  if (match === undefined) {
    throw new ConfigError(`Coinbase does not publish a ${String(timeframe)}us candle`, {
      timeframe,
      supported: GRANULARITIES.map(([, seconds]) => seconds),
    });
  }
  return match[1];
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class CoinbaseDataProvider implements DataProvider {
  readonly id = 'coinbase';
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly requestDelayMs: number;
  private readonly specs = new Map<string, InstrumentSpec>();

  constructor(options: CoinbaseProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.exchange.coinbase.com').replace(/\/+$/, '');
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.maxAttempts = options.maxAttempts ?? 4;
    this.requestDelayMs = options.requestDelayMs ?? 250;
  }

  /** Builds an instrument spec from the product's own increments, so no scale is guessed. */
  async describe(symbol: string): Promise<InstrumentSpec> {
    const cached = this.specs.get(symbol);
    if (cached !== undefined) return cached;

    const payload = await this.request(`${this.baseUrl}/products/${encodeURIComponent(symbol)}`);
    const parsed = ProductSchema.safeParse(payload);
    if (!parsed.success) {
      throw new MarketDataError('the product response did not match the expected shape', {
        symbol,
        issues: parsed.error.issues.slice(0, 5),
      });
    }
    const product = parsed.data;
    if (product.status !== 'online') {
      throw new NotFoundError(`Coinbase reports ${symbol} as ${product.status}, not online`, {
        symbol,
        status: product.status,
      });
    }

    const spec: InstrumentSpec = {
      symbol: product.id,
      venue: 'COINBASE',
      kind: 'spot',
      currency: product.quote_currency,
      priceExp: decimalsOf(product.quote_increment),
      qtyExp: decimalsOf(product.base_increment),
      tickSize: trimZeros(product.quote_increment),
      lotSize: trimZeros(product.base_increment),
      pointValue: '1',
      accounting: 'cash',
    };
    this.specs.set(symbol, spec);
    return spec;
  }

  /**
   * Streams closed candles for a range.
   *
   * Coinbase answers a window newest-first and prints nothing at all for a bucket in which nothing
   * traded, so a page is sorted before it is appended and gaps stay gaps. A candle whose close
   * lies past the requested end is dropped rather than truncated: a bar that has not finished
   * forming is not a bar, and letting one through is a quiet way to hand a strategy the future.
   */
  async *bars(request: BarRequest): AsyncIterable<BarChunk> {
    const instrument = await this.describe(request.symbol);
    const granularity = coinbaseGranularity(request.timeframe);
    const stepMicros = request.timeframe;
    const chunkSize = request.chunkSize ?? 50_000;

    let builder = new BarChunkBuilder(0 as InstrumentId, request.timeframe, chunkSize);
    // Plain microseconds while paging; the branded Timestamp is what the request carries, not what
    // a loop counter needs.
    let cursor: number = request.from;
    let firstPage = true;
    let lastOpenTs = -Infinity;

    while (cursor < request.to) {
      if (!firstPage && this.requestDelayMs > 0) await this.sleep(this.requestDelayMs);
      firstPage = false;

      // The window is inclusive at both ends, so it stops one candle short of where the next one
      // starts. Overlapping them instead would deliver every boundary candle twice.
      const windowEnd = Math.min(cursor + PAGE_CANDLES * stepMicros, request.to);
      const url =
        `${this.baseUrl}/products/${encodeURIComponent(request.symbol)}/candles` +
        `?granularity=${String(granularity)}` +
        `&start=${isoSeconds(cursor)}&end=${isoSeconds(windowEnd - stepMicros)}`;

      const parsed = CandlesSchema.safeParse(await this.request(url));
      if (!parsed.success) {
        throw new MarketDataError('the candles response did not match the expected shape', {
          issues: parsed.error.issues.slice(0, 5),
        });
      }

      const rows = [...parsed.data].sort((a, b) => a[0] - b[0]);
      for (const [seconds, low, high, open, close, volume] of rows) {
        const openTs = seconds * MICROS_PER_SECOND;
        const closeTs = openTs + stepMicros;
        if (closeTs > request.to) continue;
        // A window whose predecessor already delivered its first candle would otherwise duplicate
        // it, and a duplicated bar is a bar the strategy trades twice.
        if (openTs <= lastOpenTs) continue;
        lastOpenTs = openTs;

        builder.push(
          openTs,
          closeTs,
          parseFixed(decimalString(open), instrument.priceExp),
          parseFixed(decimalString(high), instrument.priceExp),
          parseFixed(decimalString(low), instrument.priceExp),
          parseFixed(decimalString(close), instrument.priceExp),
          parseFixed(decimalString(volume), instrument.qtyExp),
        );
        if (builder.count >= chunkSize) {
          yield builder.build();
          builder = new BarChunkBuilder(0 as InstrumentId, request.timeframe, chunkSize);
        }
      }

      cursor = windowEnd;
    }

    if (builder.count > 0) yield builder.build();
  }

  /**
   * One HTTP call, with backoff on the statuses the venue uses to say "slow down".
   *
   * Coinbase requires a `User-Agent`; a request without one is answered with a 403 that looks
   * exactly like a permissions problem and is not.
   */
  private async request(url: string): Promise<unknown> {
    let lastStatus = 0;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const response = await this.doFetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'tapedeck' },
      });
      if (response.ok) {
        try {
          return await response.json();
        } catch (cause: unknown) {
          throw new UpstreamError('Coinbase returned a body that is not JSON', {
            url,
            cause: String(cause),
          });
        }
      }

      lastStatus = response.status;
      if (response.status === 404) {
        throw new NotFoundError('Coinbase does not list this product', { url });
      }
      if (!RETRYABLE.has(response.status) || attempt === this.maxAttempts) break;

      const retryAfter = Number(response.headers.get('retry-after') ?? '');
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 2 ** attempt * 250;
      await this.sleep(waitMs);
    }

    throw new UpstreamError(`Coinbase request failed with status ${String(lastStatus)}`, {
      url,
      status: lastStatus,
      attempts: this.maxAttempts,
    });
  }
}

/** The venue takes ISO-8601; microseconds would be rejected, so the instant is cut to seconds. */
function isoSeconds(micros: number): string {
  return new Date(Math.floor(micros / MICROS_PER_SECOND) * 1_000)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z');
}
