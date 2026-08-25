/**
 * B3 daily price reports.
 *
 * B3 publishes one file per trading session — the BVBG.086 price report, ISO-20022 XML, a zip
 * inside a zip, about 175 MB unpacked — containing one `PricRpt` per instrument that traded. For a
 * futures contract that record carries open, high, low, last, the settlement price, volume in
 * contracts and open interest: a complete daily bar, plus the two fields that let a roll be
 * measured rather than assumed.
 *
 * **Nothing fetched here is committed, and that is not a stylistic choice.** B3's own Consumption
 * Policy makes B3 the exclusive holder of the data, permits *internal* use, and requires prior
 * approval and a signed adhesion agreement to redistribute. Downloading it to your machine and
 * backtesting on it is internal use; putting it in a public repository is redistribution. So this
 * provider writes a local `.tape` and the repository stays empty of B3 prices (ADR-0011, ADR-0015).
 *
 * Two limits worth knowing before you plan around it:
 *
 * - **Daily bars only.** Intraday B3 history is a paid product and is not in this file. A strategy
 *   that needs minutes cannot be researched from here.
 * - **One request per session.** A year is roughly 250 downloads of 15 MB. The extracted result is
 *   a few kilobytes, so the cost is the fetch, not the storage.
 */

import {
  type BarChunk,
  type BarRequest,
  type DataProvider,
  type InstrumentId,
  type InstrumentSpec,
  type Timestamp,
  type TradingCalendar,
  BarChunkBuilder,
  ConfigError,
  INSTRUMENTS,
  MICROS_PER_DAY,
  MarketDataError,
  NotFoundError,
  UpstreamError,
  asTimestamp,
  civilFromDays,
  parseFixed,
} from '@tapedeck/core';
import type { FetchLike } from './binance.ts';
import { extractFromZip, readZipEntries } from './zip.ts';

/** One instrument's line in a session's price report. */
export interface B3PriceRecord {
  readonly ticker: string;
  readonly tradeDate: string;
  readonly open: string | null;
  readonly high: string | null;
  readonly low: string | null;
  readonly close: string | null;
  readonly settlement: string | null;
  /** Contracts traded. */
  readonly volume: string | null;
  readonly openInterest: string | null;
}

const TAG_RE = (tag: string): RegExp => new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`);

function tagValue(block: string, tag: string): string | null {
  const match = TAG_RE(tag).exec(block);
  return match?.[1] ?? null;
}

/**
 * Pulls the price records out of a BVBG.086 document.
 *
 * A regex scan rather than a DOM parse, and deliberately: the document is hundreds of megabytes
 * and only a handful of its records are wanted, so building a tree of all of them to discard
 * 99.99% would cost more memory than the file. `PricRpt` elements do not nest, which is what makes
 * the scan safe — a general XML regex would not be.
 */
export function scanPriceReport(
  xml: string,
  wanted: (ticker: string) => boolean,
): readonly B3PriceRecord[] {
  const out: B3PriceRecord[] = [];
  const open = '<PricRpt>';
  const close = '</PricRpt>';
  let at = 0;

  for (;;) {
    const start = xml.indexOf(open, at);
    if (start === -1) break;
    const end = xml.indexOf(close, start);
    if (end === -1) break;
    at = end + close.length;

    const block = xml.slice(start, at);
    const ticker = tagValue(block, 'TckrSymb');
    if (ticker === null || !wanted(ticker)) continue;

    out.push({
      ticker,
      tradeDate: tagValue(block, 'Dt') ?? '',
      open: tagValue(block, 'FrstPric'),
      high: tagValue(block, 'MaxPric'),
      low: tagValue(block, 'MinPric'),
      close: tagValue(block, 'LastPric'),
      settlement: tagValue(block, 'AdjstdQt'),
      volume: tagValue(block, 'FinInstrmQty'),
      openInterest: tagValue(block, 'OpnIntrst'),
    });
  }
  return out;
}

export interface B3ProviderOptions {
  readonly fetch?: FetchLike | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly baseUrl?: string | undefined;
  /** Pause between sessions, so a year-long fetch does not hammer the exchange. */
  readonly requestDelayMs?: number | undefined;
  /** Sessions to skip on a 404 before giving up. Holidays the calendar did not know about. */
  readonly maxMissingSessions?: number | undefined;
}

/** `PRyymmdd.zip`, which is how B3 names a session's bulletin. */
export function bulletinName(ts: Timestamp): string {
  const { year, month, day } = civilFromDays(Math.floor(ts / MICROS_PER_DAY));
  const two = (value: number): string => String(value).padStart(2, '0');
  return `PR${two(year % 100)}${two(month)}${two(day)}.zip`;
}

export interface B3BarRequest extends BarRequest {
  /** The exact contracts to extract, e.g. `['WINV26', 'WINZ26']`. */
  readonly contracts: readonly string[];
  /** Decides which days to ask for. Skipping weekends and holidays is most of the saving. */
  readonly calendar: TradingCalendar;
  /**
   * Take the settlement price as the bar's close instead of the last trade.
   *
   * The settlement is what margin is computed against and what the exchange treats as the day's
   * price, and it is not always a price that traded. Which one is right depends on what the
   * strategy is modelling, so it is a decision the caller makes rather than one buried here.
   *
   * Note that B3 publishes settlements at finer precision than the contract trades at — a real
   * WDO session settled at 5212.939 against a tick of 0.5 — so the value is rounded to the
   * instrument's price scale on the way in. It was never a tradable price to begin with.
   */
  readonly useSettlement?: boolean | undefined;
}

export class B3DataProvider implements DataProvider {
  readonly id = 'b3';
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly requestDelayMs: number;
  private readonly maxMissing: number;

  constructor(options: B3ProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://www.b3.com.br').replace(/\/+$/, '');
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.requestDelayMs = options.requestDelayMs ?? 500;
    this.maxMissing = options.maxMissingSessions ?? 20;
  }

  /**
   * The contract specification for a root symbol.
   *
   * B3 does not publish scales in the price report, so these come from `INSTRUMENTS`, where the
   * tick and point value are transcribed from the contract sheet. The margin figures there remain
   * placeholders and are documented as such.
   */
  describe(symbol: string): Promise<InstrumentSpec> {
    const root = symbol.toUpperCase().slice(0, 3);
    const known: Readonly<Record<string, InstrumentSpec>> = {
      WIN: INSTRUMENTS.WIN,
      WDO: INSTRUMENTS.WDO,
    };
    const spec = known[root];
    if (spec === undefined) {
      // Rejected, not thrown: the signature promises a promise, and a caller reaching for
      // .catch() must not have the failure go past them synchronously.
      return Promise.reject(
        new NotFoundError(
          `no instrument specification for ${symbol}; add one to INSTRUMENTS or pass a spec`,
          { symbol, known: Object.keys(known) },
        ),
      );
    }
    return Promise.resolve({ ...spec, symbol: symbol.toUpperCase() });
  }

  /** Daily bars for the requested contracts, one chunk per contract. */
  bars(request: BarRequest | B3BarRequest): AsyncIterable<BarChunk> {
    if (!isB3Request(request)) {
      throw new ConfigError('the B3 provider needs `contracts` and a `calendar` on the request', {
        symbol: request.symbol,
      });
    }
    return this.contractBars(request);
  }

  /**
   * One session's records for the requested contracts.
   *
   * Public because it is the useful unit: a caller wanting open interest, or several contracts at
   * once, wants records rather than a chunk of one contract's bars.
   */
  async session(
    ts: Timestamp,
    wanted: (ticker: string) => boolean,
  ): Promise<readonly B3PriceRecord[]> {
    const name = bulletinName(ts);
    const url = `${this.baseUrl}/pesquisapregao/download?filelist=${name}`;
    const response = await this.doFetch(url);
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new UpstreamError(`B3 returned ${String(response.status)} for ${name}`, {
        url,
        status: response.status,
      });
    }

    const outer = Buffer.from(await response.arrayBuffer());
    if (outer.length === 0) return [];
    // The published file wraps a second archive, which is the one holding the XML documents.
    const inner = extractFromZip(outer, (entry) => entry.name.toLowerCase().endsWith('.zip'));
    const documents = readZipEntries(inner.contents).filter((entry) =>
      entry.name.toLowerCase().endsWith('.xml'),
    );
    if (documents.length === 0) {
      throw new MarketDataError(`${name} contained no XML price report`, { name });
    }

    // Several documents cover one session; the last is the final one, after any correction.
    const last = documents[documents.length - 1];
    if (last === undefined) return [];
    const { contents } = extractFromZip(inner.contents, last.name);
    return scanPriceReport(contents.toString('utf8'), wanted);
  }

  private async *contractBars(request: B3BarRequest): AsyncIterable<BarChunk> {
    const instrument = await this.describe(request.symbol);
    const wanted = new Set(request.contracts.map((c) => c.toUpperCase()));
    const builders = new Map<string, BarChunkBuilder>();
    const chunkSize = request.chunkSize ?? 4_096;
    let missing = 0;
    let first = true;

    for (
      let day = Math.floor(request.from / MICROS_PER_DAY);
      day * MICROS_PER_DAY < request.to;
      day++
    ) {
      const noon = request.calendar.atLocalMinute(day, 720);
      if (!request.calendar.isTradingDay(noon)) continue;
      if (!first && this.requestDelayMs > 0) await this.sleep(this.requestDelayMs);
      first = false;

      const records = await this.session(noon, (ticker) => wanted.has(ticker.toUpperCase()));
      if (records.length === 0) {
        missing++;
        if (missing > this.maxMissing) {
          throw new UpstreamError(
            `${String(missing)} consecutive sessions returned nothing; the download endpoint or ` +
              `the file naming has probably changed`,
            { from: request.from, to: request.to },
          );
        }
        continue;
      }
      missing = 0;

      const sessionOpen = request.calendar.nextOpen(request.calendar.atLocalMinute(day, 0));
      const sessionClose = request.calendar.nextClose(sessionOpen);
      for (const record of records) {
        const builder =
          builders.get(record.ticker) ??
          new BarChunkBuilder(0 as InstrumentId, request.timeframe, chunkSize);
        builders.set(record.ticker, builder);
        const bar = toBar(record, instrument, request.useSettlement ?? false);
        if (bar === null) continue;
        builder.push(sessionOpen, sessionClose, bar.open, bar.high, bar.low, bar.close, bar.volume);
      }
    }

    for (const builder of builders.values()) {
      if (builder.count > 0) yield builder.build();
    }
  }
}

interface RawBar {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/**
 * Turns a record into fixed-point columns, or into nothing.
 *
 * A contract can appear in the report having settled without trading — open interest and a
 * settlement price, no open, no high, no low. That is not a bar and inventing one from the
 * settlement alone would put a four-way-identical candle into the series, so it is dropped.
 */
function toBar(
  record: B3PriceRecord,
  instrument: InstrumentSpec,
  useSettlement: boolean,
): RawBar | null {
  const { open, high, low } = record;
  const close = useSettlement ? (record.settlement ?? record.close) : record.close;
  if (open === null || high === null || low === null || close === null) return null;

  return {
    open: parseFixed(open, instrument.priceExp),
    high: parseFixed(high, instrument.priceExp),
    low: parseFixed(low, instrument.priceExp),
    close: parseFixed(close, instrument.priceExp),
    volume: parseFixed(record.volume ?? '0', instrument.qtyExp),
  };
}

function isB3Request(request: BarRequest): request is B3BarRequest {
  const candidate = request as Partial<B3BarRequest>;
  return Array.isArray(candidate.contracts) && candidate.calendar !== undefined;
}

/** Convenience for a caller that has a `from`/`to` in ISO and wants the session list. */
export function tradingSessionsBetween(
  calendar: TradingCalendar,
  from: Timestamp,
  to: Timestamp,
): readonly Timestamp[] {
  const out: Timestamp[] = [];
  for (let day = Math.floor(from / MICROS_PER_DAY); day * MICROS_PER_DAY < to; day++) {
    const noon = calendar.atLocalMinute(day, 720);
    if (calendar.isTradingDay(noon)) out.push(asTimestamp(noon));
  }
  return out;
}
