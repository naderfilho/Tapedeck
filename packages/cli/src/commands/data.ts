/**
 * `tapedeck data fetch` and `tapedeck data convert`.
 *
 * Fetch talks to public endpoints only and holds no credentials (ADR-0011). Convert turns a CSV
 * export into a `.tape`, which is the step that makes everything downstream fast: a CSV is parsed
 * once, here, and never again.
 *
 * Both write the same self-describing file, so a tape fetched from a venue and a tape converted
 * from a spreadsheet are indistinguishable to the engine.
 */

import { resolve } from 'node:path';
import { z } from 'zod';
import {
  type BarChunk,
  type InstrumentSpec,
  type Store,
  BarChunkBuilder,
  B3,
  type ContractSeries,
  B3_SERIES,
  ConfigError,
  TradingCalendar,
  asTimestamp,
  contractsBetween,
  fromIso,
  parseTimeframe,
  toIso,
} from '@tapedeck/core';
import {
  type ContractBars,
  B3DataProvider,
  BinanceDataProvider,
  CsvBarProvider,
  encodeBarTape,
  stitchContinuous,
} from '@tapedeck/data';
import type { CliIo } from '../io.ts';

const FetchSchema = z.object({
  symbol: z.string().min(1),
  timeframe: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  out: z.string().min(1),
  venue: z.enum(['binance', 'b3']).optional(),
  store: z.string().optional(),
  quiet: z.boolean().optional(),
});

const ConvertSchema = z.object({
  instrument: z.string().min(1),
  timeframe: z.string().min(1),
  out: z.string().min(1),
  timestampUnit: z.enum(['iso', 'ms', 's', 'us']).optional(),
  timestampIs: z.enum(['open', 'close']).optional(),
  delimiter: z.string().length(1).optional(),
  quiet: z.boolean().optional(),
});

/**
 * Only the fields the engine actually needs, validated rather than trusted. An instrument file is
 * something a user hand-writes, which makes it exactly the kind of input that should be checked.
 */
const InstrumentSchema = z.object({
  symbol: z.string().min(1),
  venue: z.string().min(1),
  kind: z.enum(['future', 'stock', 'spot', 'option']),
  currency: z.string().min(1),
  priceExp: z.number().int().min(0).max(15),
  qtyExp: z.number().int().min(0).max(15),
  tickSize: z.string().min(1),
  lotSize: z.string().min(1),
  pointValue: z.string().min(1),
  accounting: z.enum(['cash', 'margin']).optional(),
  initialMargin: z.string().optional(),
});

export interface DataDependencies {
  readonly io: CliIo;
  readonly openStore?: ((path: string) => Store) | undefined;
  /** Injected so the fetch tests never touch a network. */
  readonly createProvider?: (() => BinanceDataProvider) | undefined;
  /** Injected so the B3 tests never touch a network. */
  readonly createB3Provider?: (() => B3DataProvider) | undefined;
}

function describeRange(chunk: BarChunk): string {
  if (chunk.count === 0) return 'no bars';
  return `${toIso(asTimestamp(chunk.openTs[0] ?? 0))} .. ${toIso(
    asTimestamp(chunk.closeTs[chunk.count - 1] ?? 0),
  )}`;
}

export async function fetchCommand(rawOptions: unknown, deps: DataDependencies): Promise<void> {
  const parsed = FetchSchema.safeParse(rawOptions);
  if (!parsed.success) {
    throw new ConfigError('invalid options for `data fetch`', { issues: parsed.error.issues });
  }
  const options = parsed.data;
  const { io } = deps;

  const timeframe = parseTimeframe(options.timeframe);
  const from = fromIso(options.from);
  const to = fromIso(options.to);
  if (to <= from)
    throw new ConfigError('--to must be after --from', { from: options.from, to: options.to });

  const venue = options.venue ?? 'binance';
  const fetched =
    venue === 'b3'
      ? await fetchB3(options, from, to, timeframe, deps)
      : await fetchBinance(options, from, to, timeframe, deps);
  const { instrument, bars } = fetched;
  if (bars.count === 0) {
    throw new ConfigError('the venue returned no candles for that range', {
      symbol: options.symbol,
      from: options.from,
      to: options.to,
    });
  }

  const source = `${venue}:${options.symbol}:${options.timeframe}:${toIso(from)}..${toIso(to)}`;
  const bytes = encodeBarTape({ instrument, chunk: bars, source, createdBy: 'tapedeck-cli' });
  io.writeFile(resolve(options.out), bytes);

  if (options.quiet !== true) {
    for (const note of fetched.notes) io.log(`  ! ${note}`);
    io.log(`${String(bars.count)} bars  ${describeRange(bars)}`);
    io.log(`${options.out}  ${(bytes.byteLength / 1024).toFixed(0)} KiB`);
  }

  if (options.store !== undefined) {
    if (deps.openStore === undefined) throw new ConfigError('this build cannot open a store');
    const store = deps.openStore(resolve(options.store));
    try {
      await store.bars.put({
        query: { venue: instrument.venue, symbol: instrument.symbol, timeframe, from, to },
        instrument,
        chunk: bars,
      });
      if (options.quiet !== true) io.log(`cached in ${options.store}`);
    } finally {
      store.close();
    }
  }
}

export function readInstrumentFile(io: CliIo, path: string): InstrumentSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(io.readFile(resolve(path))).toString('utf8'));
  } catch (cause: unknown) {
    throw new ConfigError(`${path} is not valid JSON`, { path, cause: String(cause) });
  }
  const parsed = InstrumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${path} is not a valid instrument specification`, {
      path,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export async function convertCommand(
  csvPath: string,
  rawOptions: unknown,
  deps: DataDependencies,
): Promise<void> {
  const parsed = ConvertSchema.safeParse(rawOptions);
  if (!parsed.success) {
    throw new ConfigError('invalid options for `data convert`', { issues: parsed.error.issues });
  }
  const options = parsed.data;
  const { io } = deps;

  const instrument = readInstrumentFile(io, options.instrument);
  const timeframe = parseTimeframe(options.timeframe);
  const provider = new CsvBarProvider({
    file: resolve(csvPath),
    instrument,
    timeframe,
    timestampUnit: options.timestampUnit,
    timestampIs: options.timestampIs,
    delimiter: options.delimiter,
  });

  const builder = new BarChunkBuilder(0 as never, timeframe, 16_384);
  for await (const chunk of provider.bars({
    symbol: instrument.symbol,
    timeframe,
    from: asTimestamp(0),
    to: asTimestamp(Number.MAX_SAFE_INTEGER),
  })) {
    builder.append(chunk);
  }

  const bars = builder.build();
  if (bars.count === 0) throw new ConfigError(`${csvPath} contained no bars`, { file: csvPath });

  const bytes = encodeBarTape({
    instrument,
    chunk: bars,
    source: `csv:${csvPath}`,
    createdBy: 'tapedeck-cli',
  });
  io.writeFile(resolve(options.out), bytes);

  if (options.quiet !== true) {
    io.log(`${String(bars.count)} bars  ${describeRange(bars)}`);
    io.log(`${options.out}  ${(bytes.byteLength / 1024).toFixed(0)} KiB`);
  }
}

interface Fetched {
  readonly instrument: InstrumentSpec;
  readonly bars: BarChunk;
  /** Things the fetch had to assume or could not do. Printed above the counts. */
  readonly notes: readonly string[];
}

async function fetchBinance(
  options: z.infer<typeof FetchSchema>,
  from: ReturnType<typeof fromIso>,
  to: ReturnType<typeof fromIso>,
  timeframe: ReturnType<typeof parseTimeframe>,
  deps: DataDependencies,
): Promise<Fetched> {
  const provider = deps.createProvider?.() ?? new BinanceDataProvider();
  const instrument = await provider.describe(options.symbol);
  const builder = new BarChunkBuilder(0 as never, timeframe, 16_384);
  for await (const chunk of provider.bars({
    symbol: options.symbol,
    timeframe,
    from,
    to,
    chunkSize: 1_000,
  })) {
    builder.append(chunk);
  }
  return { instrument, bars: builder.build(), notes: [] };
}

/**
 * B3 futures: fetch every contract that traded in the window, then stitch them.
 *
 * The two steps are one command because they are one decision. A tape of "WIN" that quietly
 * concatenated six contracts would have five jumps in it that no strategy could tell from a move,
 * so the stitch is not optional and the assumptions it made are printed with the result.
 */
async function fetchB3(
  options: z.infer<typeof FetchSchema>,
  from: ReturnType<typeof fromIso>,
  to: ReturnType<typeof fromIso>,
  timeframe: ReturnType<typeof parseTimeframe>,
  deps: DataDependencies,
): Promise<Fetched> {
  const root = options.symbol.toUpperCase();
  const series: ContractSeries | undefined = (
    B3_SERIES as Readonly<Record<string, ContractSeries>>
  )[root];
  if (series === undefined) {
    throw new ConfigError(`no B3 contract series named ${root}`, {
      symbol: options.symbol,
      known: Object.keys(B3_SERIES),
    });
  }

  const calendar = new TradingCalendar(B3);
  const provider = deps.createB3Provider?.() ?? new B3DataProvider();
  const instrument = await provider.describe(root);
  // A year either side of the window: the contract trading in January expired in February.
  const contracts = contractsBetween(
    series,
    calendar,
    asTimestamp(from - 400 * 86_400_000_000),
    asTimestamp(to + 400 * 86_400_000_000),
  );

  const perContract: ContractBars[] = [];
  for (const contract of contracts) {
    const builder = new BarChunkBuilder(0 as never, timeframe, 1_024);
    for await (const chunk of provider.bars({
      symbol: root,
      timeframe,
      from,
      to,
      contracts: [contract.symbol],
      calendar,
    })) {
      builder.append(chunk);
    }
    if (builder.count > 0) perContract.push({ contract, chunk: builder.build() });
  }

  if (perContract.length === 0) {
    return { instrument, bars: new BarChunkBuilder(0 as never, timeframe, 1).build(), notes: [] };
  }

  const stitched = stitchContinuous({ contracts: perContract, rollOn: 'volume' });
  return {
    instrument,
    bars: stitched.chunk,
    notes: [
      `${String(perContract.length)} contract(s) stitched, ${String(stitched.rolls.length)} roll(s)`,
      ...stitched.warnings,
    ],
  };
}
