/**
 * Binance's public WebSocket streams, turned into the chunks the engine already eats.
 *
 * Read-only, unauthenticated, and structurally incapable of being anything else: the only URLs
 * this class will open are the public market-data streams, and it refuses one that carries a
 * listen key, an API key or a signature. Paper trading drives the *simulated* broker; the only
 * thing that reaches the venue is a subscription (ADR-0011).
 *
 * Two frames matter:
 *
 * - `kline` — emitted several times per candle. Only the closed one (`k.x === true`) is passed on.
 *   An unclosed candle is a bar that has not happened yet, and handing one to a strategy is the
 *   live equivalent of lookahead.
 * - `aggTrade` — one print, with the maker flag that says which side crossed the spread.
 *
 * Timestamps are built exactly as {@link BinanceDataProvider} builds them, `closeTs = (T + 1)ms`
 * included, because the live path and the historical path have to produce byte-identical chunks
 * for the same candle. `live-replay.test.ts` in the core is the test that would fail if they drifted.
 */

import { z } from 'zod';
import {
  type BarChunk,
  type Duration,
  type InstrumentId,
  type InstrumentSpec,
  type MarketStream,
  type MarketStreamHandler,
  type TickChunk,
  type Timestamp,
  BarChunkBuilder,
  ConfigError,
  MICROS_PER_MILLI,
  TickChunkBuilder,
  parseFixed,
} from '@tapedeck/core';
import { binanceInterval } from './binance.ts';
import { type SocketFactory, nodeSocketFactory } from './socket.ts';

const KlinePayload = z.looseObject({
  e: z.literal('kline'),
  s: z.string(),
  k: z.looseObject({
    t: z.number(),
    T: z.number(),
    o: z.string(),
    h: z.string(),
    l: z.string(),
    c: z.string(),
    v: z.string(),
    x: z.boolean(),
  }),
});

const AggTradePayload = z.looseObject({
  e: z.literal('aggTrade'),
  s: z.string(),
  p: z.string(),
  q: z.string(),
  T: z.number(),
  /** True when the buyer was the maker, i.e. the seller crossed the spread. */
  m: z.boolean(),
});

/** Combined streams wrap the payload; single streams send it bare. Both are accepted. */
const Frame = z.union([
  z.looseObject({ stream: z.string(), data: z.unknown() }),
  z.looseObject({ e: z.string() }),
]);

/** Just the discriminator, read before the full payload so a bad frame can be told from a dull one. */
const Discriminator = z.looseObject({ e: z.string() });

const CREDENTIAL_PATTERN = /listenkey|apikey|api_key|signature|secret/i;

export interface BinanceStreamOptions {
  readonly symbol: string;
  readonly kinds: readonly ('bar' | 'tick')[];
  /** Required when `kinds` includes `bar`. */
  readonly timeframe?: Duration | undefined;
  /** Scales for the incoming price and quantity strings. Fetched by `start()` when absent. */
  readonly instrument?: InstrumentSpec | undefined;
  /** Used by `start()` to fetch the spec when one was not supplied. */
  readonly describe?: ((symbol: string) => Promise<InstrumentSpec>) | undefined;
  /** Id the emitted chunks carry. Must match the engine's registration order. Defaults to 0. */
  readonly instrumentId?: InstrumentId | undefined;
  readonly baseUrl?: string | undefined;
  readonly createSocket?: SocketFactory | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Wall clock, for measuring how much tape a reconnection missed. */
  readonly now?: (() => Timestamp) | undefined;
  readonly maxBackoffMs?: number | undefined;
}

export interface BinanceStreamStats {
  frames: number;
  bars: number;
  ticks: number;
  /** Frames that parsed but said nothing this stream subscribes to, e.g. an unclosed candle. */
  ignored: number;
  /** Frames that did not parse at all. Counted rather than thrown: one bad frame is not a crash. */
  malformed: number;
  connects: number;
  reconnects: number;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export class BinanceStream implements MarketStream {
  readonly stats: BinanceStreamStats = {
    frames: 0,
    bars: 0,
    ticks: 0,
    ignored: 0,
    malformed: 0,
    connects: 0,
    reconnects: 0,
  };

  private readonly options: BinanceStreamOptions;
  private readonly handler: MarketStreamHandler;
  private readonly createSocket: SocketFactory;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Timestamp;
  private readonly maxBackoffMs: number;
  private readonly instrumentId: InstrumentId;
  private readonly symbol: string;

  private instrument: InstrumentSpec | null = null;
  private socket: ReturnType<SocketFactory> | null = null;
  private stopped = false;
  private opened: Deferred | null = null;
  private closed: Deferred | null = null;
  /** Venue time of the last event seen, so a reconnection can say how much it missed. */
  private lastEventTs: Timestamp | null = null;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(options: BinanceStreamOptions, handler: MarketStreamHandler) {
    if (options.kinds.length === 0) {
      throw new ConfigError('a stream must subscribe to bars, ticks, or both');
    }
    if (options.kinds.includes('bar') && options.timeframe === undefined) {
      throw new ConfigError('a bar stream needs a timeframe');
    }
    this.options = options;
    this.handler = handler;
    this.createSocket = options.createSocket ?? nodeSocketFactory;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.now =
      options.now ??
      // An adapter may read the wall clock; the kernel may not (ADR-0006).
      ((): Timestamp => (Date.now() * MICROS_PER_MILLI) as Timestamp);
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.instrumentId = options.instrumentId ?? (0 as InstrumentId);
    this.symbol = options.symbol.toUpperCase();
  }

  /** The URL this stream will open. Exposed because a paper session should print what it joined. */
  get url(): string {
    const base = (this.options.baseUrl ?? 'wss://stream.binance.com:9443').replace(/\/+$/, '');
    const lower = this.symbol.toLowerCase();
    const streams: string[] = [];
    if (this.options.kinds.includes('bar')) {
      const timeframe = this.options.timeframe;
      if (timeframe === undefined) throw new ConfigError('a bar stream needs a timeframe');
      streams.push(`${lower}@kline_${binanceInterval(timeframe)}`);
    }
    if (this.options.kinds.includes('tick')) streams.push(`${lower}@aggTrade`);
    const url = `${base}/stream?streams=${streams.join('/')}`;
    if (CREDENTIAL_PATTERN.test(url)) {
      throw new ConfigError('this stream is market data only and refuses an authenticated URL', {
        url,
      });
    }
    return url;
  }

  /**
   * Connects, and keeps connecting.
   *
   * Resolves the first time the socket opens; the reconnection loop then runs behind it for as
   * long as the session lives. A caller awaiting `start()` is waiting for a feed, not for the end
   * of the world.
   */
  async start(): Promise<void> {
    if (this.stopped) throw new ConfigError('this stream has already been stopped');
    if (this.instrument === null) {
      const supplied = this.options.instrument;
      if (supplied !== undefined) this.instrument = supplied;
      else if (this.options.describe !== undefined) {
        this.instrument = await this.options.describe(this.symbol);
      } else {
        throw new ConfigError('a stream needs an instrument spec or a way to fetch one', {
          symbol: this.symbol,
        });
      }
    }

    const first = deferred();
    let resolvedFirst = false;
    this.loopDone = this.loop(() => {
      if (resolvedFirst) return;
      resolvedFirst = true;
      first.resolve();
    });
    // A stop() before the first open must not leave the caller hanging.
    await Promise.race([first.promise, this.loopDone]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket?.close();
    this.closed?.resolve();
    this.opened?.resolve();
    await this.loopDone;
  }

  /**
   * Read through a method rather than as a field, because `stop()` can flip it during any of the
   * awaits below and a narrowed `this.stopped` would make the checks after them dead code.
   */
  private isStopped(): boolean {
    return this.stopped;
  }

  private async loop(onFirstOpen: () => void): Promise<void> {
    let attempt = 0;
    while (!this.isStopped()) {
      attempt++;
      this.handler.onStatus({ kind: 'connecting', attempt });
      const opened = await this.openSocket();
      if (this.isStopped()) break;

      if (!opened) {
        await this.sleep(backoffMs(attempt, this.maxBackoffMs));
        continue;
      }

      this.stats.connects++;
      if (this.stats.connects > 1) {
        this.stats.reconnects++;
        const since = this.lastEventTs === null ? 0 : Math.max(0, this.now() - this.lastEventTs);
        this.handler.onStatus({ kind: 'gap', sinceMicros: since });
      }
      attempt = 0;
      this.handler.onStatus({ kind: 'connected', url: this.url });
      onFirstOpen();

      await (this.closed?.promise ?? Promise.resolve());
      if (this.isStopped()) break;
      await this.sleep(backoffMs(1, this.maxBackoffMs));
    }
    this.handler.onStatus({ kind: 'closed' });
    onFirstOpen();
  }

  /** Opens one socket. Resolves true when it opened, false when it died first. */
  private openSocket(): Promise<boolean> {
    const opened = deferred();
    const closed = deferred();
    this.opened = opened;
    this.closed = closed;
    let didOpen = false;

    const socket = this.createSocket(this.url);
    this.socket = socket;

    socket.onOpen(() => {
      didOpen = true;
      opened.resolve();
    });
    socket.onMessage((data) => {
      this.onFrame(data);
    });
    // After `stop()` the socket is expected to close, so its closing is not news. Reporting it
    // would put a `disconnected` after the `closed` that ends the session's log.
    socket.onError((error) => {
      if (!didOpen) opened.resolve();
      else if (!this.isStopped()) this.handler.onStatus({ kind: 'disconnected', reason: error });
      closed.resolve();
    });
    socket.onClose((reason) => {
      if (!didOpen) opened.resolve();
      else if (!this.isStopped()) this.handler.onStatus({ kind: 'disconnected', reason });
      closed.resolve();
    });

    return opened.promise.then(() => didOpen);
  }

  /**
   * Turns one text frame into a chunk, or into nothing.
   *
   * A frame that does not parse is counted, not thrown: a venue that sends one malformed message
   * should not take a paper session down, and the count is in the report either way.
   */
  private onFrame(text: string): void {
    this.stats.frames++;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      this.stats.malformed++;
      return;
    }

    const frame = Frame.safeParse(payload);
    if (!frame.success) {
      this.stats.malformed++;
      return;
    }
    const data = 'stream' in frame.data ? frame.data.data : frame.data;
    const kind = Discriminator.safeParse(data);
    if (!kind.success) {
      this.stats.malformed++;
      return;
    }

    // A frame that says what it is and then does not look like it is malformed; a frame for
    // something this stream never subscribed to is merely uninteresting. Counting them together
    // would hide a venue that changed its payload behind a number that always looks busy.
    switch (kind.data.e) {
      case 'kline': {
        const kline = KlinePayload.safeParse(data);
        if (kline.success) this.onKline(kline.data);
        else this.stats.malformed++;
        return;
      }
      case 'aggTrade': {
        const trade = AggTradePayload.safeParse(data);
        if (trade.success) this.onAggTrade(trade.data);
        else this.stats.malformed++;
        return;
      }
      default:
        this.stats.ignored++;
        return;
    }
  }

  private onKline(payload: z.infer<typeof KlinePayload>): void {
    const instrument = this.instrument;
    const timeframe = this.options.timeframe;
    if (instrument === null || timeframe === undefined) return;
    if (payload.s.toUpperCase() !== this.symbol || !this.options.kinds.includes('bar')) {
      this.stats.ignored++;
      return;
    }
    // An unclosed candle is not a bar. Passing one on would be handing the strategy a price that
    // can still change — lookahead wearing a live disguise.
    if (!payload.k.x) {
      this.stats.ignored++;
      return;
    }

    const { k } = payload;
    const builder = new BarChunkBuilder(this.instrumentId, timeframe, 1);
    builder.push(
      k.t * MICROS_PER_MILLI,
      (k.T + 1) * MICROS_PER_MILLI,
      parseFixed(k.o, instrument.priceExp),
      parseFixed(k.h, instrument.priceExp),
      parseFixed(k.l, instrument.priceExp),
      parseFixed(k.c, instrument.priceExp),
      parseFixed(k.v, instrument.qtyExp),
    );
    const chunk: BarChunk = builder.build();
    this.lastEventTs = ((k.T + 1) * MICROS_PER_MILLI) as Timestamp;
    this.stats.bars++;
    this.handler.onBars(chunk);
  }

  private onAggTrade(payload: z.infer<typeof AggTradePayload>): void {
    const instrument = this.instrument;
    if (instrument === null) return;
    if (payload.s.toUpperCase() !== this.symbol || !this.options.kinds.includes('tick')) {
      this.stats.ignored++;
      return;
    }

    const builder = new TickChunkBuilder(this.instrumentId, 1);
    builder.push(
      payload.T * MICROS_PER_MILLI,
      parseFixed(payload.p, instrument.priceExp),
      parseFixed(payload.q, instrument.qtyExp),
      // `m` says the buyer was the maker, so the seller is the one who crossed the spread.
      payload.m ? -1 : 1,
    );
    const chunk: TickChunk = builder.build();
    this.lastEventTs = (payload.T * MICROS_PER_MILLI) as Timestamp;
    this.stats.ticks++;
    this.handler.onTicks(chunk);
  }
}

function backoffMs(attempt: number, cap: number): number {
  return Math.min(cap, 2 ** Math.min(attempt, 10) * 250);
}
