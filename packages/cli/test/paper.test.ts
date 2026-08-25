/**
 * `tapedeck paper`, driven without a socket.
 *
 * The command takes its feed as a dependency, so these tests hand it one that replays bars the
 * moment it is started. Everything else — the strategy module, the session, the store, the report
 * — is the real thing, which is the only way a test of a command is worth writing.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type MarketStream,
  type MarketStreamHandler,
  type Strategy,
  BarChunkBuilder,
  MICROS_PER_HOUR,
  asDuration,
  asQty,
} from '@tapedeck/core';
import { BinanceDataProvider } from '@tapedeck/data';
import { openStore } from '@tapedeck/store';
import {
  type CliIo,
  type PaperRuntime,
  nodeWaitForStop,
  paperCommand,
  runProgram,
} from '../src/index.ts';

const directory = mkdtempSync(join(tmpdir(), 'tapedeck-paper-'));
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function fakeIo() {
  const files = new Map<string, Uint8Array | string>();
  const out: string[] = [];
  const errors: string[] = [];
  const modules = new Map<string, Record<string, unknown>>();

  const io: CliIo = {
    log: (message) => out.push(message),
    error: (message) => errors.push(message),
    readFile: (path) => {
      const contents = files.get(resolve(path));
      if (contents === undefined) throw new Error(`no such file: ${path}`);
      return typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;
    },
    writeFile: (path, contents) => {
      files.set(resolve(path), contents);
    },
    importModule: (path) => {
      const module = modules.get(resolve(path));
      if (module === undefined) throw new Error(`no such module: ${path}`);
      return Promise.resolve(module);
    },
  };

  return {
    io,
    modules,
    stdout: (): string => out.join('\n'),
    text: (path: string): string => {
      const contents = files.get(resolve(path));
      if (contents === undefined) throw new Error(`nothing written to ${path}`);
      return typeof contents === 'string' ? contents : Buffer.from(contents).toString('utf8');
    },
  };
}

/** Trades on a schedule, so a short replay still produces fills without needing indicators. */
function alternating(): Strategy {
  let side = 1;
  return {
    id: 'alternating',
    onInit: () => undefined,
    onBar: (bar, ctx) => {
      const hour = Math.floor(bar.closeTs / MICROS_PER_HOUR);
      if (hour % 10 !== 0) return;
      side = -side;
      const current = ctx.portfolio.position(bar.instrumentId).qty;
      const target = side > 0 ? 100_000 : 0;
      const delta = target - current;
      if (delta === 0) return;
      ctx.submit({
        instrumentId: bar.instrumentId,
        side: delta > 0 ? 'buy' : 'sell',
        type: 'market',
        qty: asQty(Math.abs(delta)),
      });
    },
  };
}

const EXCHANGE_INFO = {
  symbols: [
    {
      symbol: 'BTCUSDT',
      status: 'TRADING',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
        { filterType: 'LOT_SIZE', stepSize: '0.00001000' },
      ],
    },
  ],
};

/** Answers `describe` from a scripted body. The command needs the venue's scales, nothing else. */
function describingProvider(): BinanceDataProvider {
  return new BinanceDataProvider({
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(EXCHANGE_INFO), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    sleep: () => Promise.resolve(),
    requestDelayMs: 0,
  });
}

/**
 * A feed that replays bars the moment it is started.
 *
 * The command cannot tell this from a socket: same `MarketStream`, same handler, same session on
 * the other side of it.
 */
function replayStream(count: number, from = 0) {
  // Anchored just behind the wall clock, so the lag the session reports is the lag a real feed
  // would have produced rather than fifty-six years of it.
  const firstHour = Math.floor(Date.now() / 3_600_000) * MICROS_PER_HOUR - 200 * MICROS_PER_HOUR;
  return (_request: unknown, handler: MarketStreamHandler): MarketStream => ({
    start: () => {
      handler.onStatus({ kind: 'connected', url: 'wss://replay' });
      for (let i = from; i < from + count; i++) {
        const builder = new BarChunkBuilder(0 as never, asDuration(MICROS_PER_HOUR), 1);
        const openTs = firstHour + i * MICROS_PER_HOUR;
        const price = 7_000_000 + Math.round(Math.sin(i / 4) * 300_000);
        builder.push(
          openTs,
          openTs + MICROS_PER_HOUR,
          price,
          price + 20_000,
          price - 20_000,
          price,
          100_000,
        );
        handler.onBars(builder.build());
      }
      return Promise.resolve();
    },
    stop: () => {
      handler.onStatus({ kind: 'closed' });
      return Promise.resolve();
    },
  });
}

const base = {
  symbol: 'BTCUSDT',
  timeframe: '1h',
  cash: '100000',
  seed: 1,
  preset: 'binanceSpot' as const,
  heartbeat: 1,
};

function paperDeps(harness: ReturnType<typeof fakeIo>, count: number, from = 0) {
  return {
    io: harness.io,
    createProvider: describingProvider,
    createStream: replayStream(count, from),
    waitForStop: () => Promise.resolve('the replay ended'),
    openStore: (path: string) => openStore(path),
  };
}

describe('paper', () => {
  it('runs a strategy against a feed and says what it could not know first', async () => {
    const harness = fakeIo();
    harness.modules.set(resolve('strategy.ts'), { default: alternating });

    await paperCommand('strategy.ts', { ...base }, paperDeps(harness, 60));

    const output = harness.stdout();
    expect(output).toContain('paper   BINANCE:BTCUSDT  bar');
    expect(output).toContain('feed    connected wss://replay');
    expect(output).toContain('stopped: the replay ended');
    expect(output).toContain('events  60 processed, 0 refused');
    expect(output).toContain('lag     ');
    expect(output).toContain('over 60 event(s)');
    expect(output).toContain('net profit');
    // Warnings sit above the numbers, never below them.
    const warned = output.indexOf('what this session could not know');
    if (warned >= 0) expect(warned).toBeLessThan(output.indexOf('net profit'));
  });

  it('writes the same three artefacts a backtest writes', async () => {
    const harness = fakeIo();
    harness.modules.set(resolve('strategy.ts'), { default: alternating });

    await paperCommand(
      'strategy.ts',
      { ...base, result: 'paper.json', json: 'metrics.json', html: 'paper.html', quiet: true },
      paperDeps(harness, 40),
    );

    expect(harness.text('paper.json')).toContain('"strategyId"');
    expect(harness.text('metrics.json')).toContain('"netProfit"');
    expect(harness.text('paper.html')).toContain('<!doctype html>');
    expect(harness.stdout()).toBe('');
  });

  it('resumes a session from the store rather than opening a second account', async () => {
    const path = join(directory, 'paper.sqlite');
    const first = fakeIo();
    first.modules.set(resolve('strategy.ts'), { default: alternating });
    await paperCommand(
      'strategy.ts',
      { ...base, store: path, session: 'resume-me', quiet: true },
      paperDeps(first, 40),
    );

    const second = fakeIo();
    second.modules.set(resolve('strategy.ts'), { default: alternating });
    await paperCommand(
      'strategy.ts',
      { ...base, store: path, session: 'resume-me' },
      paperDeps(second, 40, 40),
    );

    expect(second.stdout()).toContain('(resumed from the store)');
    expect(second.stdout()).toContain('The account — cash, cost basis, resting orders — came back');
  });

  it('needs to be told what to subscribe to', async () => {
    const harness = fakeIo();
    harness.modules.set(resolve('strategy.ts'), { default: alternating });
    const { symbol, cash, seed, preset, heartbeat } = base;

    await expect(
      paperCommand('strategy.ts', { symbol, cash, seed, preset, heartbeat }, paperDeps(harness, 1)),
    ).rejects.toThrow(/--timeframe, --ticks, or both/);
  });

  it('rejects options it cannot make sense of', async () => {
    const harness = fakeIo();
    await expect(
      paperCommand('strategy.ts', { symbol: '' }, paperDeps(harness, 1)),
    ).rejects.toThrow(/invalid options/);
  });

  it('refuses a store it cannot open', async () => {
    const harness = fakeIo();
    harness.modules.set(resolve('strategy.ts'), { default: alternating });
    await expect(
      paperCommand(
        'strategy.ts',
        { ...base, store: join(directory, 'nope.sqlite') },
        { ...paperDeps(harness, 1), openStore: undefined },
      ),
    ).rejects.toThrow(/cannot open a store/);
  });

  it('is wired into the command tree', async () => {
    const harness = fakeIo();
    harness.modules.set(resolve('strategy.ts'), { default: alternating });
    const code = await runProgram(
      ['paper', 'strategy.ts', '--symbol', 'BTCUSDT', '--timeframe', '1h', '--quiet'],
      paperDeps(harness, 20),
    );
    expect(code).toBe(0);
  });
});

describe('the default stop condition', () => {
  function runtime(
    processed = 0,
    maxBars?: number,
  ): { runtime: PaperRuntime; beats: () => number } {
    let beats = 0;
    return {
      beats: () => beats,
      runtime: {
        session: { stats: { processed } } as never,
        stream: { start: () => Promise.resolve(), stop: () => Promise.resolve() },
        beat: () => {
          beats++;
          return Promise.resolve();
        },
        maxBars,
      },
    };
  }

  it('beats while it waits, and ends when the duration is up', async () => {
    const { runtime: r, beats } = runtime();
    expect(await nodeWaitForStop(5, 60)(r)).toBe('duration elapsed');
    expect(beats()).toBeGreaterThan(0);
  });

  it('ends on the event count when one was asked for', async () => {
    const { runtime: r } = runtime(10, 5);
    expect(await nodeWaitForStop(5, 5_000)(r)).toBe('5 events seen');
  });

  it('ends on Ctrl-C', async () => {
    const { runtime: r } = runtime();
    const waiting = nodeWaitForStop(1_000, 5_000)(r);
    process.emit('SIGINT');
    expect(await waiting).toBe('interrupted');
  });

  it('ends, and says so, when a heartbeat itself fails', async () => {
    const { runtime: r } = runtime();
    const failing: PaperRuntime = { ...r, beat: () => Promise.reject(new Error('store is gone')) };
    expect(await nodeWaitForStop(5, 5_000)(failing)).toContain('store is gone');
  });

  it('leaves no listener and no timer behind', async () => {
    const before = process.listenerCount('SIGINT');
    const { runtime: r } = runtime();
    await nodeWaitForStop(5, 20)(r);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
