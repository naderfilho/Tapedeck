/**
 * The CLI is driven directly rather than through a spawned process: the commands are functions
 * taking an IO object, so a test can hand them a fake filesystem and a fake venue and read back
 * exactly what would have been written.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type InstrumentSpec,
  type Strategy,
  ConfigError,
  INSTRUMENTS,
  MICROS_PER_HOUR,
  asDuration,
  asQty,
  BarChunkBuilder,
} from '@tapedeck/core';
import { BinanceDataProvider, decodeBarTape, encodeBarTape } from '@tapedeck/data';
import { openStore } from '@tapedeck/store';
import {
  type CliIo,
  convertCommand,
  fetchCommand,
  VERSION,
  createProgram,
  parseParams,
  readInstrumentFile,
  reportCommand,
  resolveStrategyFactory,
  runCommand,
  runProgram,
} from '../src/index.ts';

const directory = mkdtempSync(join(tmpdir(), 'tapedeck-cli-'));
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

const SPEC: InstrumentSpec = INSTRUMENTS.BTCUSDT;

/** An in-memory filesystem, so a test never leaves anything behind or reads anything it did not write. */
function fakeIo(seed: Record<string, Uint8Array | string> = {}) {
  const files = new Map<string, Uint8Array | string>();
  for (const [path, contents] of Object.entries(seed)) files.set(resolve(path), contents);
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
    files,
    modules,
    stdout: (): string => out.join('\n'),
    stderr: (): string => errors.join('\n'),
    text: (path: string): string => {
      const contents = files.get(resolve(path));
      if (contents === undefined) throw new Error(`nothing written to ${path}`);
      return typeof contents === 'string' ? contents : Buffer.from(contents).toString('utf8');
    },
  };
}

function tapeBytes(bars = 200): Uint8Array {
  const builder = new BarChunkBuilder(0 as never, asDuration(MICROS_PER_HOUR), bars);
  for (let i = 0; i < bars; i++) {
    const openTs = i * MICROS_PER_HOUR;
    // A slow sine so a crossover actually crosses.
    const price = 7_000_000 + Math.round(Math.sin(i / 12) * 200_000);
    builder.push(
      openTs,
      openTs + MICROS_PER_HOUR,
      price,
      price + 5_000,
      price - 5_000,
      price,
      100_000,
    );
  }
  return encodeBarTape({ instrument: SPEC, chunk: builder.build(), source: 'test:BTCUSDT:1h' });
}

/** A strategy that trades on a schedule, so the run produces trades without needing indicators. */
function alternating(): Strategy {
  let side = 1;
  return {
    id: 'alternating',
    onInit: () => undefined,
    onBar: (bar, ctx) => {
      if (bar.index % 20 !== 0) return;
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

describe('strategy resolution', () => {
  it('accepts a default export or a named one', () => {
    expect(resolveStrategyFactory({ default: alternating }, 'x.ts')).toBe(alternating);
    expect(resolveStrategyFactory({ strategy: alternating }, 'x.ts')).toBe(alternating);
  });

  it('says what it expected when the module exports something else', () => {
    expect(() => resolveStrategyFactory({ notAStrategy: 1 }, 'mine.ts')).toThrow(
      /must export a strategy factory/,
    );
  });
});

describe('parameter parsing', () => {
  it('accepts an object and nothing else', () => {
    expect(parseParams('{"fast":3}')).toEqual({ fast: 3 });
    expect(parseParams(undefined)).toEqual({});
    expect(parseParams('  ')).toEqual({});
    expect(() => parseParams('[1,2]')).toThrow(ConfigError);
    expect(() => parseParams('nonsense')).toThrow(/must be a JSON object/);
  });
});

describe('run', () => {
  const base = {
    data: 'data.tape',
    cash: '100000',
    seed: 7,
    preset: 'binanceSpot' as const,
  };

  function setup() {
    const harness = fakeIo({ 'data.tape': tapeBytes() });
    harness.modules.set(resolve('strategy.ts'), { default: alternating });
    return harness;
  }

  it('replays the tape and prints a summary a person can read', async () => {
    const harness = setup();
    await runCommand('strategy.ts', base, { io: harness.io });

    const output = harness.stdout();
    expect(output).toContain('alternating');
    expect(output).toContain('test:BTCUSDT:1h');
    expect(output).toContain('Sharpe');
    expect(output).toContain('max drawdown');
  });

  it('writes the result, the metrics and the report when asked', async () => {
    const harness = setup();
    await runCommand(
      'strategy.ts',
      { ...base, result: 'out/run.json', json: 'out/metrics.json', html: 'out/report.html' },
      { io: harness.io },
    );

    const result = JSON.parse(harness.text('out/run.json')) as { config: { seed: number } };
    expect(result.config.seed).toBe(7);

    const metrics = JSON.parse(harness.text('out/metrics.json')) as { trades: { count: number } };
    expect(metrics.trades.count).toBeGreaterThan(0);

    const html = harness.text('out/report.html');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('<script');
  });

  it('is reproducible: the same arguments write the same bytes', async () => {
    const first = setup();
    const second = setup();
    await runCommand('strategy.ts', { ...base, result: 'a.json', quiet: true }, { io: first.io });
    await runCommand('strategy.ts', { ...base, result: 'b.json', quiet: true }, { io: second.io });
    expect(first.text('a.json')).toBe(second.text('b.json'));
  });

  it('passes the chosen intrabar policy through to the engine', async () => {
    const harness = setup();
    await runCommand(
      'strategy.ts',
      { ...base, intrabar: 'optimistic' as const, result: 'run.json', quiet: true },
      { io: harness.io },
    );
    expect(harness.text('run.json')).toContain('"intrabarPolicy": "optimistic"');
  });

  it('says nothing at all when told to be quiet', async () => {
    const harness = setup();
    await runCommand('strategy.ts', { ...base, quiet: true }, { io: harness.io });
    expect(harness.stdout()).toBe('');
  });

  it('refuses options it cannot make sense of', async () => {
    const harness = setup();
    await expect(
      runCommand('strategy.ts', { ...base, preset: 'nonexistent' }, { io: harness.io }),
    ).rejects.toThrow(ConfigError);
  });

  it('saves the run to a store when one is given', async () => {
    const harness = setup();
    const path = join(directory, 'runs.sqlite');
    await runCommand(
      'strategy.ts',
      { ...base, store: path, runId: 'cli-run', quiet: true },
      { io: harness.io, openStore: (p) => openStore(p) },
    );

    const store = openStore(path);
    try {
      const stored = await store.runs.load('cli-run');
      expect(stored?.result.config.strategyId).toBe('alternating');
    } finally {
      store.close();
    }
  });
});

describe('report', () => {
  async function produceResult() {
    const harness = fakeIo({ 'data.tape': tapeBytes() });
    harness.modules.set(resolve('strategy.ts'), { default: alternating });
    await runCommand(
      'strategy.ts',
      {
        data: 'data.tape',
        cash: '100000',
        seed: 1,
        preset: 'ideal' as const,
        result: 'run.json',
        quiet: true,
      },
      { io: harness.io },
    );
    return harness;
  }

  it('reads a stored run and reproduces its metrics', async () => {
    const harness = await produceResult();
    reportCommand('run.json', { json: 'metrics.json', html: 'report.html' }, harness.io);

    expect(harness.stdout()).toContain('Trades');
    expect(harness.text('metrics.json')).toContain('"netProfit"');
    expect(harness.text('report.html')).toContain('aria-label="Equity curve"');
  });

  it('applies the risk-free rate and the period override it was given', async () => {
    const harness = await produceResult();
    reportCommand('run.json', { json: 'a.json', quiet: true }, harness.io);
    reportCommand(
      'run.json',
      { json: 'b.json', riskFreeRate: 0.1, periodsPerYear: 252, quiet: true },
      harness.io,
    );
    expect(harness.text('a.json')).not.toBe(harness.text('b.json'));
    expect(harness.text('b.json')).toContain('"periodsPerYear": 252');
  });

  it('rejects a file that is not a run result', () => {
    const harness = fakeIo({ 'junk.json': 'not json at all' });
    expect(() => {
      reportCommand('junk.json', {}, harness.io);
    }).toThrow(/is not a Tapedeck run result/);
  });
});

describe('data convert', () => {
  const csv = [
    'timestamp,open,high,low,close,volume',
    '2026-01-01T00:00:00.000Z,70000.00,70100.00,69900.00,70050.00,1.5',
    '2026-01-01T01:00:00.000Z,70050.00,70200.00,70000.00,70150.00,2.0',
  ].join('\n');

  it('turns a CSV into a tape the engine can replay', async () => {
    // Convert streams the CSV from the real filesystem, so that one file is written for real; the
    // instrument spec and the output stay in the fake one.
    const csvPath = join(directory, 'bars.csv');
    const specPath = join(directory, 'instrument.json');
    const outPath = join(directory, 'bars.tape');
    writeFileSync(csvPath, csv, 'utf8');

    const harness = fakeIo({ [specPath]: JSON.stringify(SPEC) });
    await convertCommand(
      csvPath,
      { instrument: specPath, timeframe: '1h', out: outPath, timestampUnit: 'iso' as const },
      { io: harness.io },
    );

    expect(harness.stdout()).toContain('2 bars');
    const file = decodeBarTape(harness.files.get(resolve(outPath)) as Uint8Array);
    expect(file.chunk.count).toBe(2);
    expect(file.chunk.close[0]).toBe(7_005_000);
  });

  it('validates the instrument file instead of trusting it', () => {
    const harness = fakeIo({
      'bad.json': JSON.stringify({ symbol: 'X' }),
      'notjson.json': '{{{',
    });
    expect(() => readInstrumentFile(harness.io, 'bad.json')).toThrow(/not a valid instrument/);
    expect(() => readInstrumentFile(harness.io, 'notjson.json')).toThrow(/not valid JSON/);
    expect(readInstrumentFile(fakeIo({ 'ok.json': JSON.stringify(SPEC) }).io, 'ok.json')).toEqual(
      SPEC,
    );
  });
});

describe('the command tree', () => {
  it('describes itself', async () => {
    const harness = fakeIo();
    const program = createProgram({ io: harness.io });
    await expect(program.parseAsync(['--help'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.helpDisplayed',
    });
    const help = harness.stdout();
    expect(help).toContain('run');
    expect(help).toContain('report');
    expect(help).toContain('data');
  });

  it('wires run through commander end to end', async () => {
    const harness = fakeIo({ 'data.tape': tapeBytes(120) });
    harness.modules.set(resolve('strategy.ts'), { default: alternating });
    const program = createProgram({ io: harness.io });

    await program.parseAsync(
      ['run', 'strategy.ts', '--data', 'data.tape', '--seed', '3', '--json', 'm.json', '--quiet'],
      { from: 'user' },
    );

    expect(harness.text('m.json')).toContain('"count"');
  });

  it('refuses a run with no data argument', async () => {
    const harness = fakeIo();
    const program = createProgram({ io: harness.io });
    await expect(
      program.parseAsync(['run', 'strategy.ts'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'commander.missingMandatoryOptionValue' });
  });
});

describe('data fetch', () => {
  const hourMs = 3_600_000;
  const fromMs = Date.UTC(2026, 0, 1);

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

  /** A provider wired to a scripted venue, so `fetch` is exercised without a network. */
  function scriptedProvider(pages: unknown[]): BinanceDataProvider {
    const bodies = [EXCHANGE_INFO, ...pages];
    return new BinanceDataProvider({
      fetch: () => {
        const body = bodies.shift();
        if (body === undefined) throw new Error('unexpected request');
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
      sleep: () => Promise.resolve(),
      requestDelayMs: 0,
    });
  }

  const candles = (count: number): unknown[][] =>
    Array.from({ length: count }, (_, i) => [
      fromMs + i * hourMs,
      '70000.00',
      '70100.00',
      '69900.00',
      '70050.00',
      '1.5',
      fromMs + (i + 1) * hourMs - 1,
    ]);

  const options = {
    symbol: 'BTCUSDT',
    timeframe: '1h',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T05:00:00.000Z',
    out: 'fetched.tape',
  };

  it('writes a tape the engine can read straight back', async () => {
    const harness = fakeIo();
    await fetchCommand(options, {
      io: harness.io,
      createProvider: () => scriptedProvider([candles(5)]),
    });

    expect(harness.stdout()).toContain('5 bars');
    const file = decodeBarTape(harness.files.get(resolve('fetched.tape')) as Uint8Array);
    expect(file.chunk.count).toBe(5);
    expect(file.instrument.priceExp).toBe(2);
    expect(file.header.source).toContain('binance:BTCUSDT:1h');
  });

  it('caches the range when a store is given', async () => {
    const harness = fakeIo();
    const path = join(directory, 'cache.sqlite');
    await fetchCommand(
      { ...options, store: path, quiet: true },
      {
        io: harness.io,
        createProvider: () => scriptedProvider([candles(5)]),
        openStore: (p) => openStore(p),
      },
    );

    const store = openStore(path);
    try {
      const coverage = await store.bars.coverage('BINANCE', 'BTCUSDT', asDuration(MICROS_PER_HOUR));
      expect(coverage).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('refuses a range that runs backwards', async () => {
    const harness = fakeIo();
    await expect(
      fetchCommand(
        { ...options, from: options.to, to: options.from },
        { io: harness.io, createProvider: () => scriptedProvider([]) },
      ),
    ).rejects.toThrow(/--to must be after --from/);
  });

  it('says so when the venue has nothing for the range', async () => {
    const harness = fakeIo();
    await expect(
      fetchCommand(options, { io: harness.io, createProvider: () => scriptedProvider([[]]) }),
    ).rejects.toThrow(/returned no candles/);
  });

  it('rejects options it cannot make sense of', async () => {
    const harness = fakeIo();
    await expect(fetchCommand({ ...options, timeframe: '' }, { io: harness.io })).rejects.toThrow(
      ConfigError,
    );
  });
});

describe('exit codes', () => {
  it('returns zero for a command that worked', async () => {
    const harness = fakeIo({ 'data.tape': tapeBytes(80) });
    harness.modules.set(resolve('strategy.ts'), { default: alternating });
    const code = await runProgram(['run', 'strategy.ts', '--data', 'data.tape', '--quiet'], {
      io: harness.io,
    });
    expect(code).toBe(0);
  });

  it('returns zero for --help and --version, which commander signals by throwing', async () => {
    const help = fakeIo();
    expect(await runProgram(['--help'], { io: help.io })).toBe(0);
    expect(help.stdout()).toContain('Usage');

    const version = fakeIo();
    expect(await runProgram(['--version'], { io: version.io })).toBe(0);
    expect(version.stdout()).toContain(VERSION);
  });

  it('turns a Tapedeck error into a message and an exit code, not a stack', async () => {
    const harness = fakeIo();
    harness.modules.set(resolve('strategy.ts'), { nothingUseful: true });
    const code = await runProgram(['run', 'strategy.ts', '--data', 'missing.tape'], {
      io: harness.io,
    });

    expect(code).toBe(1);
    expect(harness.stderr()).toContain('error:');
    expect(harness.stderr()).toContain('must export a strategy factory');
    expect(harness.stderr()).not.toContain('at Object.');
  });

  it('lets an unexpected failure keep its stack, because a bug needs one', async () => {
    const harness = fakeIo();
    harness.modules.set(resolve('strategy.ts'), {
      default: () => {
        throw new RangeError('something nobody predicted');
      },
    });
    await expect(
      runProgram(['run', 'strategy.ts', '--data', 'data.tape'], { io: harness.io }),
    ).rejects.toThrow(Error);
  });
});
