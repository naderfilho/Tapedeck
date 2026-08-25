/**
 * CSV bar data.
 *
 * The parser is deliberately small but not naive: it handles quoted fields, because the first CSV
 * that breaks a `split(',')` will be someone's exported broker statement and the failure will look
 * like corrupt prices rather than a parsing bug.
 *
 * Numbers are carried from the file to {@link parseFixed} **as strings**. That is the whole point:
 * `parseFloat('0.1')` has already lost the value by the time anyone rounds it (ADR-0002).
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import {
  type BarChunk,
  type BarRequest,
  type DataProvider,
  type Duration,
  type InstrumentId,
  type InstrumentSpec,
  type Timestamp,
  BarChunkBuilder,
  ConfigError,
  MarketDataError,
  asTimestamp,
  fromIso,
  parseFixed,
} from '@tapedeck/core';

export type TimestampUnit = 'iso' | 'ms' | 's' | 'us';

const ColumnMapSchema = z.object({
  ts: z.string().min(1),
  open: z.string().min(1),
  high: z.string().min(1),
  low: z.string().min(1),
  close: z.string().min(1),
  volume: z.string().min(1),
  closeTs: z.string().min(1).optional(),
});

const CsvOptionsSchema = z.object({
  file: z.string().min(1),
  timeframe: z.number().int().positive(),
  columns: ColumnMapSchema.partial().optional(),
  timestampUnit: z.enum(['iso', 'ms', 's', 'us']).optional(),
  timestampIs: z.enum(['open', 'close']).optional(),
  delimiter: z.string().length(1).optional(),
  chunkSize: z.number().int().positive().optional(),
});

export type CsvColumnMap = z.infer<typeof ColumnMapSchema>;

export interface CsvProviderOptions {
  /** Path to the file. */
  readonly file: string;
  readonly instrument: InstrumentSpec;
  /** Bar duration in microseconds, used to derive a close from an open timestamp. */
  readonly timeframe: Duration;
  /** Header names, when they differ from the defaults below. */
  readonly columns?: Partial<CsvColumnMap> | undefined;
  readonly timestampUnit?: TimestampUnit | undefined;
  /** Whether the timestamp column marks the start or the end of the bar. Defaults to `open`. */
  readonly timestampIs?: 'open' | 'close' | undefined;
  readonly delimiter?: string | undefined;
  /** Bars per yielded chunk. Larger means fewer awaits and more memory. */
  readonly chunkSize?: number | undefined;
}

const DEFAULT_COLUMNS: CsvColumnMap = {
  ts: 'timestamp',
  open: 'open',
  high: 'high',
  low: 'low',
  close: 'close',
  volume: 'volume',
};

/**
 * Splits one CSV line. Handles `"quoted, fields"` and the doubled `""` escape; everything else is
 * taken literally, which is what market data files contain.
 */
export function splitCsvLine(line: string, delimiter = ','): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    // charAt returns a string for any index, which keeps the loop free of undefined checks.
    const char = line.charAt(i);
    if (quoted) {
      if (char === '"') {
        if (line.charAt(i + 1) === '"') {
          current += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

export function parseTimestamp(raw: string, unit: TimestampUnit): Timestamp {
  if (unit === 'iso') return fromIso(raw);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new MarketDataError(`timestamp is not a number: ${JSON.stringify(raw)}`, { raw });
  }
  const micros = unit === 'us' ? value : unit === 'ms' ? value * 1_000 : value * 1_000_000;
  if (!Number.isSafeInteger(micros)) {
    throw new MarketDataError(`timestamp is out of range: ${JSON.stringify(raw)}`, { raw, unit });
  }
  return asTimestamp(micros);
}

/**
 * Reads bars from a local CSV.
 *
 * Streams the file line by line, so a multi-gigabyte minute-bar export costs one chunk of memory
 * rather than the whole file.
 */
export class CsvBarProvider implements DataProvider {
  readonly id = 'csv';
  private readonly options: CsvProviderOptions;
  private readonly columns: CsvColumnMap;
  private readonly delimiter: string;
  private readonly unit: TimestampUnit;

  constructor(options: CsvProviderOptions) {
    const parsed = CsvOptionsSchema.safeParse({
      file: options.file,
      timeframe: options.timeframe,
      columns: options.columns,
      timestampUnit: options.timestampUnit,
      timestampIs: options.timestampIs,
      delimiter: options.delimiter,
      chunkSize: options.chunkSize,
    });
    if (!parsed.success) {
      throw new ConfigError('invalid CSV provider options', { issues: parsed.error.issues });
    }
    this.options = options;
    this.columns = { ...DEFAULT_COLUMNS, ...options.columns };
    this.delimiter = options.delimiter ?? ',';
    this.unit = options.timestampUnit ?? 'ms';
  }

  describe(): Promise<InstrumentSpec> {
    return Promise.resolve(this.options.instrument);
  }

  async *bars(request: BarRequest): AsyncIterable<BarChunk> {
    const { instrument, timeframe } = this.options;
    const priceExp = instrument.priceExp;
    const qtyExp = instrument.qtyExp;
    const chunkSize = request.chunkSize ?? this.options.chunkSize ?? 50_000;
    const timestampIsClose = (this.options.timestampIs ?? 'open') === 'close';

    const stream = createReadStream(this.options.file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });

    let indices: Record<keyof CsvColumnMap, number> | null = null;
    let builder = new BarChunkBuilder(0 as InstrumentId, timeframe, chunkSize);
    let lineNumber = 0;

    try {
      for await (const rawLine of lines) {
        lineNumber++;
        const line = rawLine.trim();
        if (line === '') continue;
        const fields = splitCsvLine(line, this.delimiter);

        if (indices === null) {
          indices = this.resolveHeader(fields);
          continue;
        }

        const at = (index: number): string => {
          const field = fields[index];
          if (field === undefined) {
            throw new MarketDataError(`line ${String(lineNumber)} has too few columns`, {
              lineNumber,
              expected: index + 1,
              found: fields.length,
            });
          }
          return field.trim();
        };

        const stamp = parseTimestamp(at(indices.ts), this.unit);
        const closeTs =
          indices.closeTs >= 0
            ? parseTimestamp(at(indices.closeTs), this.unit)
            : asTimestamp(timestampIsClose ? stamp : stamp + timeframe);
        const openTs = asTimestamp(timestampIsClose ? closeTs - timeframe : stamp);

        if (openTs < request.from || closeTs > request.to) continue;

        builder.push(
          openTs,
          closeTs,
          parseFixed(at(indices.open), priceExp),
          parseFixed(at(indices.high), priceExp),
          parseFixed(at(indices.low), priceExp),
          parseFixed(at(indices.close), priceExp),
          parseFixed(at(indices.volume), qtyExp),
        );

        if (builder.count >= chunkSize) {
          yield builder.build();
          builder = new BarChunkBuilder(0 as InstrumentId, timeframe, chunkSize);
        }
      }
    } finally {
      lines.close();
      stream.close();
    }

    if (indices === null) {
      throw new MarketDataError(`${this.options.file} is empty: no header row`, {
        file: this.options.file,
      });
    }
    if (builder.count > 0) yield builder.build();
  }

  private resolveHeader(fields: readonly string[]): Record<keyof CsvColumnMap, number> {
    const header = fields.map((field) => field.trim().toLowerCase());
    const find = (name: string, required: boolean): number => {
      const index = header.indexOf(name.toLowerCase());
      if (index === -1 && required) {
        throw new MarketDataError(`CSV is missing the ${name} column`, { name, header });
      }
      return index;
    };
    return {
      ts: find(this.columns.ts, true),
      open: find(this.columns.open, true),
      high: find(this.columns.high, true),
      low: find(this.columns.low, true),
      close: find(this.columns.close, true),
      volume: find(this.columns.volume, true),
      closeTs: this.columns.closeTs === undefined ? -1 : find(this.columns.closeTs, true),
    };
  }
}
