/**
 * The live feed.
 *
 * Nothing here opens a socket. The stream talks to a {@link StreamSocket}, so a test hands it a
 * fake, pushes frames through it and asserts on what came out the other side — including the
 * paths that are impossible to provoke on demand against a real venue: a malformed frame, a
 * connection dropped mid-session, a candle that has not closed.
 *
 * The last test is the one that matters most. It takes the committed year of real BTCUSDT, turns
 * it back into the WebSocket frames the venue would have sent, feeds those through the socket, the
 * parser, the queue and the kernel, and asserts the fills are the ones a plain backtest over the
 * same bars produces. That is the phase-4 claim, end to end, on real prices.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  type BarChunk,
  type LiveEvent,
  type MarketStreamHandler,
  type Strategy,
  type StreamStatus,
  type TickChunk,
  LiveSession,
  MICROS_PER_HOUR,
  MICROS_PER_MILLI,
  asDuration,
  asPrice,
  asQty,
  asTimestamp,
  formatFixed,
  runBacktest,
} from '@tapedeck/core';
import type { InstrumentId, InstrumentSpec } from '@tapedeck/core';
import { BinanceStream, readBarTapeFileSync } from '../src/index.ts';
import type { BinanceStreamOptions } from '../src/index.ts';
import type { StreamSocket } from '../src/index.ts';

const TAPE = fileURLToPath(new URL('../../../fixtures/binance-BTCUSDT-1h.tape', import.meta.url));

const SPEC: InstrumentSpec = {
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
};

/** A socket the test drives by hand. Every callback the real one has, and no network. */
class FakeSocket implements StreamSocket {
  static readonly opened: FakeSocket[] = [];
  closed = false;
  private openHandler: (() => void) | null = null;
  private messageHandler: ((data: string) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;
  private errorHandler: ((error: string) => void) | null = null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.opened.push(this);
  }

  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }
  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }
  onError(handler: (error: string) => void): void {
    this.errorHandler = handler;
  }
  close(): void {
    this.closed = true;
    this.closeHandler?.('closed by us');
  }

  emitOpen(): void {
    this.openHandler?.();
  }
  emitMessage(payload: unknown): void {
    this.messageHandler?.(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }
  emitClose(reason = '1006'): void {
    this.closeHandler?.(reason);
  }
  emitError(reason = 'boom'): void {
    this.errorHandler?.(reason);
  }
}

/**
 * Lets the stream's reconnection loop run.
 *
 * The loop is a chain of awaited promises; a test that only yields once sees it halfway through.
 * A macrotask boundary is the cheap way to let all of it settle without exposing internals.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** The socket the stream most recently created. */
function latestSocket(): FakeSocket {
  const socket = FakeSocket.opened.at(-1);
  if (socket === undefined) throw new Error('no socket was created');
  return socket;
}

interface Collected {
  readonly bars: BarChunk[];
  readonly ticks: TickChunk[];
  readonly statuses: StreamStatus[];
  readonly handler: MarketStreamHandler;
}

function collector(): Collected {
  const bars: BarChunk[] = [];
  const ticks: TickChunk[] = [];
  const statuses: StreamStatus[] = [];
  return {
    bars,
    ticks,
    statuses,
    handler: {
      onBars: (chunk) => bars.push(chunk),
      onTicks: (chunk) => ticks.push(chunk),
      onStatus: (status) => statuses.push(status),
    },
  };
}

function klineFrame(
  openMs: number,
  closeMs: number,
  ohlcv: readonly [string, string, string, string, string],
  closed = true,
): unknown {
  const [o, h, l, c, v] = ohlcv;
  return {
    stream: 'btcusdt@kline_1h',
    data: {
      e: 'kline',
      E: closeMs,
      s: 'BTCUSDT',
      k: { t: openMs, T: closeMs, i: '1h', o, h, l, c, v, x: closed },
    },
  };
}

/** Starts a stream against a fresh fake socket and opens it. */
async function connected(
  options: Partial<BinanceStreamOptions> = {},
): Promise<{ stream: BinanceStream; socket: FakeSocket; collected: Collected }> {
  FakeSocket.opened.length = 0;
  const collected = collector();
  const stream = new BinanceStream(
    {
      symbol: 'BTCUSDT',
      kinds: ['bar'],
      timeframe: asDuration(MICROS_PER_HOUR),
      instrument: SPEC,
      createSocket: (url) => new FakeSocket(url),
      sleep: () => Promise.resolve(),
      now: () => asTimestamp(0),
      ...options,
    },
    collected.handler,
  );
  const started = stream.start();
  await settle();
  const socket = latestSocket();
  socket.emitOpen();
  await started;
  return { stream, socket, collected };
}

describe('what the stream will and will not connect to', () => {
  it('subscribes to the public combined stream for the kinds it was asked for', () => {
    const stream = new BinanceStream(
      {
        symbol: 'btcusdt',
        kinds: ['bar', 'tick'],
        timeframe: asDuration(MICROS_PER_HOUR),
        instrument: SPEC,
        createSocket: (url) => new FakeSocket(url),
      },
      collector().handler,
    );
    expect(stream.url).toBe(
      'wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1h/btcusdt@aggTrade',
    );
  });

  it('refuses a URL that carries credentials (ADR-0011)', () => {
    const stream = new BinanceStream(
      {
        symbol: 'BTCUSDT',
        kinds: ['tick'],
        instrument: SPEC,
        baseUrl: 'wss://stream.binance.com:9443/ws/listenKey-abc123',
        createSocket: (url) => new FakeSocket(url),
      },
      collector().handler,
    );
    expect(() => stream.url).toThrow(/market data only/);
  });

  it('needs a timeframe before it will subscribe to candles', () => {
    expect(
      () =>
        new BinanceStream(
          { symbol: 'BTCUSDT', kinds: ['bar'], instrument: SPEC },
          collector().handler,
        ),
    ).toThrow(/timeframe/);
  });

  it('needs something to subscribe to', () => {
    expect(
      () =>
        new BinanceStream({ symbol: 'BTCUSDT', kinds: [], instrument: SPEC }, collector().handler),
    ).toThrow(/bars, ticks, or both/);
  });
});

describe('frames', () => {
  it('turns a closed candle into a one-bar chunk on the venue timestamps', async () => {
    const { socket, collected, stream } = await connected();
    socket.emitMessage(
      klineFrame(1_700_000_000_000, 1_700_003_599_999, [
        '70000.00',
        '70500.50',
        '69900.10',
        '70250.25',
        '12.34567',
      ]),
    );

    expect(collected.bars).toHaveLength(1);
    const chunk = collected.bars[0]!;
    expect(chunk.count).toBe(1);
    expect(chunk.openTs[0]).toBe(1_700_000_000_000 * MICROS_PER_MILLI);
    // Half-open interval: the bar exists at the first microsecond after the venue's close time.
    expect(chunk.closeTs[0]).toBe(1_700_003_600_000 * MICROS_PER_MILLI);
    expect(chunk.open[0]).toBe(7_000_000);
    expect(chunk.high[0]).toBe(7_050_050);
    expect(chunk.low[0]).toBe(6_990_010);
    expect(chunk.close[0]).toBe(7_025_025);
    expect(chunk.volume[0]).toBe(1_234_567);
    await stream.stop();
  });

  it('drops a candle that has not closed yet', async () => {
    const { socket, collected, stream } = await connected();
    socket.emitMessage(
      klineFrame(
        1_700_000_000_000,
        1_700_003_599_999,
        ['70000.00', '70500.50', '69900.10', '70250.25', '1'],
        false,
      ),
    );

    expect(collected.bars).toHaveLength(0);
    expect(stream.stats.ignored).toBe(1);
    await stream.stop();
  });

  it('maps the maker flag to the side that crossed the spread', async () => {
    const { socket, collected, stream } = await connected({ kinds: ['tick'] });
    const trade = (m: boolean): unknown => ({
      e: 'aggTrade',
      s: 'BTCUSDT',
      p: '70000.01',
      q: '0.50000',
      T: 1_700_000_000_000,
      m,
    });

    socket.emitMessage(trade(false));
    socket.emitMessage(trade(true));

    expect(collected.ticks).toHaveLength(2);
    // `m: false` means the buyer took the offer.
    expect(collected.ticks[0]!.aggressor[0]).toBe(1);
    expect(collected.ticks[1]!.aggressor[0]).toBe(-1);
    expect(collected.ticks[0]!.price[0]).toBe(7_000_001);
    expect(collected.ticks[0]!.size[0]).toBe(50_000);
    expect(collected.ticks[0]!.ts[0]).toBe(1_700_000_000_000 * MICROS_PER_MILLI);
    await stream.stop();
  });

  it('counts a frame it cannot read instead of dying on it', async () => {
    const { socket, collected, stream } = await connected();
    socket.emitMessage('{not json');
    // Says it is a candle and then is not one: that is a venue that changed, not a dull frame.
    socket.emitMessage({ stream: 'btcusdt@kline_1h', data: { e: 'kline', s: 'BTCUSDT' } });
    socket.emitMessage({ e: 'depthUpdate', s: 'BTCUSDT' });
    socket.emitMessage(klineFrame(0, 3_599_999, ['1.00', '1.00', '1.00', '1.00', '1']));

    expect(stream.stats.malformed).toBe(2);
    expect(stream.stats.ignored).toBe(1);
    expect(collected.bars).toHaveLength(1);
    await stream.stop();
  });

  it('ignores a symbol it did not subscribe to', async () => {
    const { socket, collected, stream } = await connected();
    socket.emitMessage({
      stream: 'ethusdt@kline_1h',
      data: {
        e: 'kline',
        s: 'ETHUSDT',
        k: { t: 0, T: 3_599_999, o: '1', h: '1', l: '1', c: '1', v: '1', x: true },
      },
    });

    expect(collected.bars).toHaveLength(0);
    expect(stream.stats.ignored).toBe(1);
    await stream.stop();
  });
});

describe('a connection that does not stay up', () => {
  it('reconnects and admits how much tape it missed', async () => {
    let wall = 0;
    const { socket, collected, stream } = await connected({ now: () => asTimestamp(wall) });
    socket.emitMessage(klineFrame(0, 3_599_999, ['1.00', '1.00', '1.00', '1.00', '1']));

    wall = 3_600_000_000 + 20_000_000; // twenty seconds past that bar's close
    socket.emitClose('1006');
    await settle();
    latestSocket().emitOpen();
    await settle();

    const gap = collected.statuses.find((status) => status.kind === 'gap');
    expect(gap).toEqual({ kind: 'gap', sinceMicros: 20_000_000 });
    expect(collected.statuses.some((s) => s.kind === 'disconnected')).toBe(true);
    expect(stream.stats.reconnects).toBe(1);
    await stream.stop();
  });

  it('stops reconnecting once it has been stopped', async () => {
    const { socket, collected, stream } = await connected();
    await stream.stop();
    socket.emitClose('1006');
    await settle();

    expect(collected.statuses.at(-1)).toEqual({ kind: 'closed' });
    expect(FakeSocket.opened).toHaveLength(1);
  });

  it('treats an error before the first open as a failed attempt', async () => {
    FakeSocket.opened.length = 0;
    const collected = collector();
    const stream = new BinanceStream(
      {
        symbol: 'BTCUSDT',
        kinds: ['bar'],
        timeframe: asDuration(MICROS_PER_HOUR),
        instrument: SPEC,
        createSocket: (url) => new FakeSocket(url),
        sleep: () => Promise.resolve(),
      },
      collected.handler,
    );
    const started = stream.start();
    await settle();
    latestSocket().emitError('refused');
    await settle();
    latestSocket().emitOpen();
    await started;

    expect(collected.statuses.filter((s) => s.kind === 'connecting').length).toBeGreaterThan(1);
    expect(collected.statuses.some((s) => s.kind === 'connected')).toBe(true);
    await stream.stop();
  });

  it('fetches the instrument spec when it was not handed one', async () => {
    FakeSocket.opened.length = 0;
    const collected = collector();
    let asked = '';
    const stream = new BinanceStream(
      {
        symbol: 'BTCUSDT',
        kinds: ['bar'],
        timeframe: asDuration(MICROS_PER_HOUR),
        describe: (symbol) => {
          asked = symbol;
          return Promise.resolve(SPEC);
        },
        createSocket: (url) => new FakeSocket(url),
        sleep: () => Promise.resolve(),
      },
      collected.handler,
    );
    const started = stream.start();
    await settle();
    latestSocket().emitOpen();
    await started;

    expect(asked).toBe('BTCUSDT');
    await stream.stop();
  });
});

describe('the whole live path, on a year of real BTCUSDT', () => {
  /**
   * A strategy that trades often enough to be a real comparison and reads nothing but the bar it
   * was handed. Deliberately not a good strategy — the assertion is an equality, not a PnL.
   */
  function crossoverish(): Strategy {
    let previous = 0;
    return {
      id: 'live-e2e',
      onInit: () => undefined,
      onBar: (bar, ctx) => {
        const flat = ctx.portfolio.position(bar.instrumentId).qty === 0;
        if (previous !== 0 && flat && bar.close > previous * 1.01) {
          ctx.submit({
            instrumentId: bar.instrumentId,
            side: 'buy',
            type: 'market',
            qty: asQty(1_000),
          });
        } else if (!flat && bar.close < previous * 0.995) {
          ctx.submit({
            instrumentId: bar.instrumentId,
            side: 'sell',
            type: 'limit',
            qty: asQty(1_000),
            limitPrice: asPrice(bar.close),
          });
        }
        previous = bar.close;
      },
    };
  }

  it('fills exactly as the backtest does, frame for bar', async () => {
    const file = readBarTapeFileSync(TAPE);
    const count = 2_000;
    const { chunk } = file;
    const slice: BarChunk = {
      instrumentId: 0 as InstrumentId,
      timeframe: chunk.timeframe,
      count,
      openTs: chunk.openTs.subarray(0, count),
      closeTs: chunk.closeTs.subarray(0, count),
      open: chunk.open.subarray(0, count),
      high: chunk.high.subarray(0, count),
      low: chunk.low.subarray(0, count),
      close: chunk.close.subarray(0, count),
      volume: chunk.volume.subarray(0, count),
    };

    const options = {
      instruments: [file.instrument],
      strategy: crossoverish,
      params: {},
      initialCash: '100000',
      seed: 3,
      flattenAtEnd: false,
    };
    const expected = runBacktest(options, [slice]);

    // Rebuild the frames the venue would have sent for exactly these candles.
    const { priceExp, qtyExp } = file.instrument;
    const frames: unknown[] = [];
    for (let i = 0; i < count; i++) {
      frames.push(
        klineFrame(
          (chunk.openTs[i] ?? 0) / MICROS_PER_MILLI,
          (chunk.closeTs[i] ?? 0) / MICROS_PER_MILLI - 1,
          [
            formatFixed(chunk.open[i] ?? 0, priceExp),
            formatFixed(chunk.high[i] ?? 0, priceExp),
            formatFixed(chunk.low[i] ?? 0, priceExp),
            formatFixed(chunk.close[i] ?? 0, priceExp),
            formatFixed(chunk.volume[i] ?? 0, qtyExp),
          ],
        ),
      );
    }

    FakeSocket.opened.length = 0;
    const session = new LiveSession(options, { sessionId: 'e2e' });
    await session.start();
    const stream = new BinanceStream(
      {
        symbol: 'BTCUSDT',
        kinds: ['bar'],
        timeframe: file.chunk.timeframe,
        instrument: file.instrument,
        createSocket: (url) => new FakeSocket(url),
        sleep: () => Promise.resolve(),
      },
      {
        onBars: (received) => {
          session.receive({ kind: 'bars', chunk: received } satisfies LiveEvent);
        },
        onTicks: () => undefined,
        onStatus: (status) => {
          session.noteStatus(status);
        },
      },
    );
    const started = stream.start();
    await settle();
    const socket = latestSocket();
    socket.emitOpen();
    await started;

    for (const frame of frames) socket.emitMessage(frame);
    await stream.stop();
    const actual = await session.stop();

    expect(session.stats.processed).toBe(count);
    expect(actual.fills.length).toBeGreaterThan(10);
    expect(actual.fills.map((f) => `${f.side}:${String(f.price)}:${String(f.qty)}`)).toEqual(
      expected.fills.map((f) => `${f.side}:${String(f.price)}:${String(f.qty)}`),
    );
    expect(actual.finalEquity).toBe(expected.finalEquity);
    expect(actual.trades).toHaveLength(expected.trades.length);
  });
});
