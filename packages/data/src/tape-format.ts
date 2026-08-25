/**
 * The `.tape` file format: a self-describing columnar container for market data.
 *
 * ```text
 * "TAPEDCK1"        8 bytes   magic and format version
 * headerLength      uint32LE
 * header            JSON, utf8, `headerLength` bytes
 * padding           to the next 8-byte boundary
 * columns           back to back, in the order the header declares
 * ```
 *
 * Parquet was the obvious alternative and was rejected (ADR-0009): every usable Node
 * implementation drags in a megabyte or two of WebAssembly, and the engine's access pattern is a
 * single sequential scan of a handful of `Float64Array` columns — the one case where a general
 * columnar format buys nothing. Reading a `.tape` is one `readFile` and a `JSON.parse`; the
 * columns are then *views* over the same buffer, with no parsing and no copy.
 *
 * The header is JSON rather than a packed struct so the format can gain a field without a version
 * bump, and so that `head -c 200 file.tape` tells you what you are holding.
 */

import {
  type BarChunk,
  type Duration,
  type InstrumentId,
  type InstrumentSpec,
  type TickChunk,
  MarketDataError,
  asDuration,
} from '@tapedeck/core';

const MAGIC = 'TAPEDCK1';
const MAGIC_BYTES = 8;
const LENGTH_BYTES = 4;
const ALIGNMENT = 8;

export type TapeKind = 'bars' | 'ticks';
export type ColumnType = 'f64' | 'i8';

export interface TapeColumn {
  readonly name: string;
  readonly dtype: ColumnType;
}

export interface TapeHeader {
  readonly kind: TapeKind;
  readonly count: number;
  readonly instrument: InstrumentSpec;
  /** Bar duration in microseconds. Absent for tick files. */
  readonly timeframe?: number;
  readonly columns: readonly TapeColumn[];
  /** Free-form provenance, e.g. `binance:BTCUSDT:1h`. */
  readonly source: string;
  readonly createdBy: string;
}

export interface TapeFile<TChunk> {
  readonly header: TapeHeader;
  readonly instrument: InstrumentSpec;
  readonly chunk: TChunk;
}

const BAR_COLUMNS: readonly TapeColumn[] = [
  { name: 'openTs', dtype: 'f64' },
  { name: 'closeTs', dtype: 'f64' },
  { name: 'open', dtype: 'f64' },
  { name: 'high', dtype: 'f64' },
  { name: 'low', dtype: 'f64' },
  { name: 'close', dtype: 'f64' },
  { name: 'volume', dtype: 'f64' },
];

const TICK_COLUMNS: readonly TapeColumn[] = [
  { name: 'ts', dtype: 'f64' },
  { name: 'price', dtype: 'f64' },
  { name: 'size', dtype: 'f64' },
  { name: 'aggressor', dtype: 'i8' },
];

function align(offset: number): number {
  const remainder = offset % ALIGNMENT;
  return remainder === 0 ? offset : offset + (ALIGNMENT - remainder);
}

function bytesPerElement(dtype: ColumnType): number {
  return dtype === 'f64' ? 8 : 1;
}

function encode(header: TapeHeader, columns: readonly ArrayBufferView[]): Uint8Array {
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const dataStart = align(MAGIC_BYTES + LENGTH_BYTES + headerJson.byteLength);

  let total = dataStart;
  const offsets: number[] = [];
  for (const column of columns) {
    offsets.push(total);
    total = align(total + column.byteLength);
  }

  const out = Buffer.alloc(total);
  out.write(MAGIC, 0, 'ascii');
  out.writeUInt32LE(headerJson.byteLength, MAGIC_BYTES);
  headerJson.copy(out, MAGIC_BYTES + LENGTH_BYTES);

  columns.forEach((column, i) => {
    const bytes = new Uint8Array(column.buffer, column.byteOffset, column.byteLength);
    out.set(bytes, offsets[i] ?? 0);
  });

  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Returns a `Float64Array` over `bytes` without copying when alignment permits, and a copy when it
 * does not. Node pools small buffers, so a file read can land at any byte offset; a typed array
 * requires an 8-byte-aligned start, and silently getting this wrong is a segfault in other
 * languages and a `RangeError` here.
 */
function viewFloat64(bytes: Uint8Array, offset: number, count: number): Float64Array {
  const absolute = bytes.byteOffset + offset;
  if (absolute % ALIGNMENT === 0) {
    return new Float64Array(bytes.buffer, absolute, count);
  }
  const copy = new Float64Array(count);
  new Uint8Array(copy.buffer).set(bytes.subarray(offset, offset + count * 8));
  return copy;
}

function viewInt8(bytes: Uint8Array, offset: number, count: number): Int8Array {
  return new Int8Array(bytes.buffer, bytes.byteOffset + offset, count);
}

function readHeader(bytes: Uint8Array): { header: TapeHeader; dataStart: number } {
  if (bytes.byteLength < MAGIC_BYTES + LENGTH_BYTES) {
    throw new MarketDataError('not a tape file: too short to contain a header');
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = buffer.toString('ascii', 0, MAGIC_BYTES);
  if (magic !== MAGIC) {
    throw new MarketDataError(`not a tape file: magic was ${JSON.stringify(magic)}`, { magic });
  }
  const headerLength = buffer.readUInt32LE(MAGIC_BYTES);
  const headerEnd = MAGIC_BYTES + LENGTH_BYTES + headerLength;
  if (headerEnd > bytes.byteLength) {
    throw new MarketDataError('tape file is truncated: header runs past the end of the file');
  }

  let header: TapeHeader;
  try {
    header = JSON.parse(buffer.toString('utf8', MAGIC_BYTES + LENGTH_BYTES, headerEnd)) as TapeHeader;
  } catch (cause: unknown) {
    throw new MarketDataError('tape header is not valid JSON', { cause: String(cause) });
  }
  return { header, dataStart: align(headerEnd) };
}

export interface EncodeBarsOptions {
  readonly instrument: InstrumentSpec;
  readonly chunk: BarChunk;
  readonly source: string;
  readonly createdBy?: string;
}

export function encodeBarTape(options: EncodeBarsOptions): Uint8Array {
  const { chunk } = options;
  const header: TapeHeader = {
    kind: 'bars',
    count: chunk.count,
    instrument: options.instrument,
    timeframe: chunk.timeframe,
    columns: BAR_COLUMNS,
    source: options.source,
    createdBy: options.createdBy ?? 'tapedeck',
  };
  return encode(header, [
    chunk.openTs,
    chunk.closeTs,
    chunk.open,
    chunk.high,
    chunk.low,
    chunk.close,
    chunk.volume,
  ]);
}

export function decodeBarTape(bytes: Uint8Array, instrumentId = 0 as InstrumentId): TapeFile<BarChunk> {
  const { header, dataStart } = readHeader(bytes);
  if (header.kind !== 'bars') {
    throw new MarketDataError(`expected a bar tape, found ${header.kind}`, {
      kind: header.kind,
    });
  }

  const { count } = header;
  const columns = new Map<string, Float64Array>();
  let offset = dataStart;
  for (const column of header.columns) {
    if (column.dtype !== 'f64') {
      throw new MarketDataError(`bar tape column ${column.name} has unexpected type`, { column });
    }
    const end = offset + count * bytesPerElement(column.dtype);
    if (end > bytes.byteLength) {
      throw new MarketDataError(`tape file is truncated inside column ${column.name}`, { column });
    }
    columns.set(column.name, viewFloat64(bytes, offset, count));
    offset = align(end);
  }

  const require = (name: string): Float64Array => {
    const column = columns.get(name);
    if (column === undefined) {
      throw new MarketDataError(`tape file is missing the ${name} column`, { name });
    }
    return column;
  };

  return {
    header,
    instrument: header.instrument,
    chunk: {
      instrumentId,
      timeframe: asDuration(header.timeframe ?? 0),
      count,
      openTs: require('openTs'),
      closeTs: require('closeTs'),
      open: require('open'),
      high: require('high'),
      low: require('low'),
      close: require('close'),
      volume: require('volume'),
    },
  };
}

export interface EncodeTicksOptions {
  readonly instrument: InstrumentSpec;
  readonly chunk: TickChunk;
  readonly source: string;
  readonly createdBy?: string;
}

export function encodeTickTape(options: EncodeTicksOptions): Uint8Array {
  const { chunk } = options;
  const header: TapeHeader = {
    kind: 'ticks',
    count: chunk.count,
    instrument: options.instrument,
    columns: TICK_COLUMNS,
    source: options.source,
    createdBy: options.createdBy ?? 'tapedeck',
  };
  return encode(header, [chunk.ts, chunk.price, chunk.size, chunk.aggressor]);
}

export function decodeTickTape(
  bytes: Uint8Array,
  instrumentId = 0 as InstrumentId,
): TapeFile<TickChunk> {
  const { header, dataStart } = readHeader(bytes);
  if (header.kind !== 'ticks') {
    throw new MarketDataError(`expected a tick tape, found ${header.kind}`, {
      kind: header.kind,
    });
  }

  const { count } = header;
  let offset = dataStart;
  const read = (dtype: ColumnType): Float64Array | Int8Array => {
    const end = offset + count * bytesPerElement(dtype);
    if (end > bytes.byteLength) throw new MarketDataError('tape file is truncated');
    const view = dtype === 'f64' ? viewFloat64(bytes, offset, count) : viewInt8(bytes, offset, count);
    offset = align(end);
    return view;
  };

  const ts = read('f64') as Float64Array;
  const price = read('f64') as Float64Array;
  const size = read('f64') as Float64Array;
  const aggressor = read('i8') as Int8Array;

  return {
    header,
    instrument: header.instrument,
    chunk: { instrumentId, count, ts, price, size, aggressor },
  };
}

/** Duration helper so callers do not have to import the core's time module to build a header. */
export function tapeTimeframe(file: TapeFile<BarChunk>): Duration {
  return asDuration(file.header.timeframe ?? 0);
}
