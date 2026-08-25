/**
 * `tapedeck paper` — run a strategy against a live feed, against a simulated broker.
 *
 * This is the command that makes the project's central claim checkable by hand: the same strategy
 * module `tapedeck run` replays over a tape is the one this command points at a socket. Nothing in
 * the strategy changes, and nothing in this file knows what the strategy does.
 *
 * No credentials are read, accepted or stored. The feed is public market data and the broker is
 * the simulator, so the worst a mistake here can do is produce a wrong number in a report
 * (ADR-0011).
 *
 * The stop condition is deliberately explicit — a duration, a bar count, or Ctrl-C — because a
 * paper session that runs until something crashes has no report at the end of it.
 */

import { resolve } from 'node:path';
import { z } from 'zod';
import {
  type MarketStream,
  type MarketStreamHandler,
  type RunOptions,
  type Store,
  type StreamStatus,
  ConfigError,
  LiveSession,
  MICROS_PER_SECOND,
  PRESETS,
  parseTimeframe,
  serializeRunResult,
} from '@tapedeck/core';
import { BinanceDataProvider, BinanceStream } from '@tapedeck/data';
import {
  computeMetrics,
  formatMetrics,
  metricsToJsonString,
  renderHtmlReport,
} from '@tapedeck/report';
import type { CliIo } from '../io.ts';
import { parseParams, resolveStrategyFactory } from './run.ts';

const PRESET_NAMES = ['ideal', 'binanceSpot', 'b3Futures', 'b3Stocks'] as const;

const OptionsSchema = z.object({
  symbol: z.string().min(1),
  timeframe: z.string().min(1).optional(),
  ticks: z.boolean().optional(),
  venue: z.enum(['binance']).optional(),
  cash: z.string().min(1),
  seed: z.coerce.number().int(),
  preset: z.enum(PRESET_NAMES),
  params: z.string().optional(),
  store: z.string().optional(),
  session: z.string().optional(),
  duration: z.coerce.number().positive().optional(),
  maxBars: z.coerce.number().int().positive().optional(),
  heartbeat: z.coerce.number().positive(),
  json: z.string().optional(),
  result: z.string().optional(),
  html: z.string().optional(),
  quiet: z.boolean().optional(),
});

export type PaperCommandOptions = z.infer<typeof OptionsSchema>;

/** What a stop-waiter is given: everything it might want to watch or interrupt. */
export interface PaperRuntime {
  readonly session: LiveSession<Record<string, never>>;
  readonly stream: MarketStream;
  /** Called on a timer, so a quiet market still moves the clock. */
  beat(): Promise<void>;
  readonly maxBars: number | undefined;
}

/** Resolves with the reason the session should end. */
export type WaitForStop = (runtime: PaperRuntime) => Promise<string>;

export interface PaperDependencies {
  readonly io: CliIo;
  readonly openStore?: ((path: string) => Store) | undefined;
  readonly createProvider?: (() => BinanceDataProvider) | undefined;
  /** Injected so a test drives a recorded frame sequence instead of a socket. */
  readonly createStream?:
    ((request: PaperStreamRequest, handler: MarketStreamHandler) => MarketStream) | undefined;
  /** Injected so a test does not wait for a wall clock. */
  readonly waitForStop?: WaitForStop | undefined;
}

export interface PaperStreamRequest {
  readonly symbol: string;
  readonly timeframeMicros: number | undefined;
  readonly kinds: readonly ('bar' | 'tick')[];
}

/**
 * The default waiter: heartbeats on a timer, ends on a duration, a bar count or Ctrl-C.
 *
 * The heartbeat is not decoration. Between two prints of a quiet instrument nothing advances
 * simulated time, so an order whose latency elapsed would sit pending until the market spoke
 * again. One beat a second costs nothing and removes the surprise.
 */
export function nodeWaitForStop(heartbeatMs: number, durationMs: number | undefined): WaitForStop {
  return (runtime: PaperRuntime) =>
    new Promise<string>((settle) => {
      let done = false;
      const finish = (reason: string): void => {
        if (done) return;
        done = true;
        clearInterval(beat);
        if (deadline !== undefined) clearTimeout(deadline);
        process.off('SIGINT', onSigint);
        settle(reason);
      };

      const onSigint = (): void => {
        finish('interrupted');
      };
      const beat = setInterval(() => {
        void runtime.beat().then(
          () => {
            const { maxBars } = runtime;
            if (maxBars !== undefined && runtime.session.stats.processed >= maxBars) {
              finish(`${String(maxBars)} events seen`);
            }
          },
          (error: unknown) => {
            finish(`the session failed: ${String(error)}`);
          },
        );
      }, heartbeatMs);
      const deadline =
        durationMs === undefined
          ? undefined
          : setTimeout(() => {
              finish('duration elapsed');
            }, durationMs);

      process.on('SIGINT', onSigint);
    });
}

function describeStatus(status: StreamStatus): string {
  switch (status.kind) {
    case 'connecting':
      return `connecting (attempt ${String(status.attempt)})`;
    case 'connected':
      return `connected ${status.url}`;
    case 'disconnected':
      return `disconnected: ${status.reason}`;
    case 'gap':
      return `reconnected, ${(status.sinceMicros / MICROS_PER_SECOND).toFixed(1)}s of tape unseen`;
    case 'closed':
      return 'feed closed';
  }
}

export async function paperCommand(
  strategyPath: string,
  rawOptions: unknown,
  deps: PaperDependencies,
): Promise<void> {
  const parsed = OptionsSchema.safeParse(rawOptions);
  if (!parsed.success) {
    throw new ConfigError('invalid options for `paper`', { issues: parsed.error.issues });
  }
  const options = parsed.data;
  const { io } = deps;

  const kinds: ('bar' | 'tick')[] = [];
  if (options.timeframe !== undefined) kinds.push('bar');
  if (options.ticks === true) kinds.push('tick');
  if (kinds.length === 0) {
    throw new ConfigError('paper trading needs --timeframe, --ticks, or both');
  }
  const timeframe = options.timeframe === undefined ? undefined : parseTimeframe(options.timeframe);

  const module = await io.importModule(resolve(strategyPath));
  const strategy = resolveStrategyFactory(module, strategyPath);

  const provider = (deps.createProvider ?? (() => new BinanceDataProvider()))();
  const instrument = await provider.describe(options.symbol);

  const store = options.store === undefined ? undefined : deps.openStore?.(resolve(options.store));
  if (options.store !== undefined && store === undefined) {
    throw new ConfigError('this build cannot open a store');
  }

  const engineOptions: RunOptions<Record<string, never>> = {
    instruments: [instrument],
    strategy,
    params: parseParams(options.params) as Record<string, never>,
    initialCash: options.cash,
    seed: options.seed,
    execution: PRESETS[options.preset](),
    // A paper session is stopped, not finished: whatever is open when it ends is open in the
    // account it will resume from, so closing it here would invent a trade.
    flattenAtEnd: false,
  };

  const sessionId = options.session ?? `${options.symbol}-${options.preset}`;
  const session = new LiveSession(engineOptions, {
    sessionId,
    ...(store === undefined ? {} : { store }),
  });

  const log = (message: string): void => {
    if (options.quiet !== true) io.log(message);
  };

  try {
    const resumed = await session.start();
    log(`paper   ${instrument.venue}:${instrument.symbol}  ${kinds.join(' + ')}`);
    log(`session ${sessionId}${resumed ? '  (resumed from the store)' : ''}`);

    const handler: MarketStreamHandler = {
      onBars: (chunk) => {
        session.receive({ kind: 'bars', chunk });
      },
      onTicks: (chunk) => {
        session.receive({ kind: 'ticks', chunk });
      },
      onStatus: (status) => {
        session.noteStatus(status);
        log(`feed    ${describeStatus(status)}`);
      },
    };

    const request: PaperStreamRequest = {
      symbol: options.symbol,
      timeframeMicros: timeframe,
      kinds,
    };
    const stream =
      deps.createStream === undefined
        ? new BinanceStream({ symbol: options.symbol, kinds, timeframe, instrument }, handler)
        : deps.createStream(request, handler);

    await stream.start();
    const wait =
      deps.waitForStop ??
      nodeWaitForStop(
        options.heartbeat * 1_000,
        options.duration === undefined ? undefined : options.duration * 1_000,
      );
    const reason = await wait({
      session,
      stream,
      beat: async () => {
        session.heartbeat();
        await session.flush();
      },
      maxBars: options.maxBars,
    });
    await stream.stop();

    const result = await session.stop();
    const metrics = computeMetrics(result);
    log(`\nstopped: ${reason}\n`);

    // Above the numbers, always. Only the session's own caveats belong here: the engine's
    // modelling caveats are printed by `formatMetrics`, at the top of its own block, and saying
    // them twice trains the reader to skip them.
    const warnings = session.warnings();
    if (warnings.length > 0 && options.quiet !== true) {
      io.log('what this session could not know');
      for (const warning of warnings) io.log(`  - ${warning}`);
      io.log('');
    }

    const { stats } = session;
    log(
      `events  ${String(stats.processed)} processed, ${String(stats.rejected)} refused, ` +
        `queue peaked at ${String(stats.maxQueueDepth)}`,
    );
    log(
      `lag     worst ${(stats.maxLagMicros / MICROS_PER_SECOND).toFixed(3)}s, ` +
        `last ${(stats.lastLagMicros / MICROS_PER_SECOND).toFixed(3)}s\n`,
    );
    log(formatMetrics(metrics, instrument.currency));

    if (options.result !== undefined) {
      io.writeFile(resolve(options.result), serializeRunResult(result));
      log(`\nresult  ${options.result}`);
    }
    if (options.json !== undefined) {
      io.writeFile(resolve(options.json), metricsToJsonString(metrics));
      log(`metrics ${options.json}`);
    }
    if (options.html !== undefined) {
      io.writeFile(
        resolve(options.html),
        renderHtmlReport(result, metrics, { currency: instrument.currency }),
      );
      log(`report  ${options.html}`);
    }
  } finally {
    store?.close();
  }
}
