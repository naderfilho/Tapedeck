/**
 * `@tapedeck/data` — the asynchronous edge.
 *
 * Everything that touches a file, a socket or an exchange lives here, and nothing here runs inside
 * the engine's loop. A provider yields chunks; the runner awaits one chunk of tens of thousands of
 * bars at a time; the engine walks each chunk without ever yielding (ADR-0003).
 *
 * Three sources, one contract:
 *
 * - {@link CsvBarProvider} for a local export,
 * - {@link BinanceDataProvider} for public historical candles,
 * - the `.tape` format for everything you have already fetched and do not want to fetch again.
 */

export {
  type ColumnType,
  type EncodeBarsOptions,
  type EncodeTicksOptions,
  type TapeColumn,
  type TapeFile,
  type TapeHeader,
  type TapeKind,
  decodeBarTape,
  decodeTickTape,
  encodeBarTape,
  encodeTickTape,
  tapeTimeframe,
} from './tape-format.ts';

export {
  readBarTapeFile,
  readBarTapeFileSync,
  readTickTapeFile,
  writeBarTapeFile,
  writeBarTapeFileSync,
  writeTickTapeFile,
} from './files.ts';

export {
  type CsvColumnMap,
  type CsvProviderOptions,
  type TimestampUnit,
  CsvBarProvider,
  parseTimestamp,
  splitCsvLine,
} from './csv.ts';

export {
  type BinanceProviderOptions,
  type FetchLike,
  BinanceDataProvider,
  binanceInterval,
  decimalsOf,
  trimZeros,
} from './binance.ts';

export {
  type BinanceStreamOptions,
  type BinanceStreamStats,
  BinanceStream,
} from './binance-stream.ts';

export { type SocketFactory, type StreamSocket, nodeSocketFactory } from './socket.ts';

export {
  type AdjustmentMethod,
  type ContinuousSeries,
  type ContractBars,
  type RollPoint,
  type RollTrigger,
  type StitchOptions,
  stitchContinuous,
} from './continuous.ts';

export {
  type B3BarRequest,
  type B3PriceRecord,
  type B3ProviderOptions,
  B3DataProvider,
  bulletinName,
  scanPriceReport,
  tradingSessionsBetween,
} from './b3.ts';

export { type ZipEntry, extractFromZip, readZipEntries, readZipEntry } from './zip.ts';
