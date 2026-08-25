/**
 * The B3 daily price report reader.
 *
 * Every fixture here is **built by the test**, never a slice of a real B3 file. That is not
 * squeamishness: B3's consumption policy permits internal use and requires prior approval to
 * redistribute, and a two-kilobyte excerpt committed to a public repository is redistribution in
 * exactly the same way a two-gigabyte one is. So the zip fixtures are made with `zlib` and the XML
 * fixtures are written in the schema's shape, with the field names and the value formats taken
 * from the published layout.
 *
 * The one thing that cannot be tested this way is whether B3 still serves the same bytes at the
 * same URL. Nothing here would notice that, and the provider throws on a run of empty sessions for
 * exactly that reason.
 */

import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
  B3,
  MarketDataError,
  TradingCalendar,
  UpstreamError,
  asDuration,
  fromIso,
} from '@tapedeck/core';
import {
  B3DataProvider,
  bulletinName,
  extractFromZip,
  readZipEntries,
  scanPriceReport,
  tradingSessionsBetween,
} from '../src/index.ts';

const calendar = new TradingCalendar(B3);

// ---------------------------------------------------------------------------- zip

/** Builds a real zip archive in memory, so the reader is tested against the format, not a mock. */
function makeZip(files: readonly { name: string; data: Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const stored = file.store ?? false;
    const payload = stored ? file.data : deflateRawSync(file.data);
    const name = Buffer.from(file.name, 'utf8');

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, payload);

    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);
    central.push(entry);

    offset += local.length + payload.length;
  }

  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}

describe('the zip reader', () => {
  it('lists and extracts a deflated entry', () => {
    const payload = Buffer.from('a'.repeat(5_000), 'utf8');
    const zip = makeZip([{ name: 'one.txt', data: payload }]);

    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['one.txt']);
    expect(entries[0]?.uncompressedSize).toBe(5_000);
    expect(entries[0]?.compressedSize).toBeLessThan(5_000);
    expect(extractFromZip(zip, 'one.txt').contents.toString()).toBe(payload.toString());
  });

  it('extracts a stored entry, which is not compressed at all', () => {
    const zip = makeZip([{ name: 'raw.bin', data: Buffer.from('hello'), store: true }]);
    expect(extractFromZip(zip, 'raw.bin').contents.toString()).toBe('hello');
  });

  it('handles a zip inside a zip, which is what B3 publishes', () => {
    const xml = Buffer.from('<Document>inner</Document>', 'utf8');
    const inner = makeZip([{ name: 'report.xml', data: xml }]);
    const outer = makeZip([{ name: 'PR260821.zip', data: inner, store: true }]);

    const unwrapped = extractFromZip(outer, (entry) => entry.name.endsWith('.zip'));
    expect(extractFromZip(unwrapped.contents, 'report.xml').contents.toString()).toBe(
      xml.toString(),
    );
  });

  it('finds an entry by predicate as well as by name', () => {
    const zip = makeZip([
      { name: 'notes.txt', data: Buffer.from('x') },
      { name: 'BVBG.086.01_BV0003.xml', data: Buffer.from('<Document/>') },
    ]);
    const found = extractFromZip(zip, (entry) => entry.name.endsWith('.xml'));
    expect(found.entry.name).toContain('BVBG');
  });

  it('says what is wrong instead of reading garbage', () => {
    expect(() => readZipEntries(Buffer.from('not a zip at all, not even close'))).toThrow(
      /not a zip file/,
    );
    const zip = makeZip([{ name: 'a', data: Buffer.from('x') }]);
    expect(() => extractFromZip(zip, 'missing')).toThrow(MarketDataError);
    expect(() => extractFromZip(zip, 'missing')).toThrow(/no entry matched/);
  });

  it('refuses an entry it cannot decompress rather than returning nonsense', () => {
    const zip = makeZip([{ name: 'a', data: Buffer.from('x') }]);
    // Method 12 is bzip2, which this reader does not implement.
    zip.writeUInt16LE(12, findCentralHeader(zip) + 10);
    expect(() => extractFromZip(zip, 'a')).toThrow(/compression method 12/);
  });
});

function findCentralHeader(zip: Buffer): number {
  for (let at = 0; at < zip.length - 4; at++) {
    if (zip.readUInt32LE(at) === 0x02014b50) return at;
  }
  throw new Error('no central header in fixture');
}

// ---------------------------------------------------------------------------- xml

/** A price report in the shape B3 publishes, with the field names from the layout. */
function priceReport(
  records: readonly {
    ticker: string;
    open?: string;
    high?: string;
    low?: string;
    close?: string;
    settlement?: string;
    volume?: string;
    openInterest?: string;
  }[],
): string {
  const blocks = records.map(
    (r) => `<PricRpt>
      <TradDt><Dt>2026-08-21</Dt></TradDt>
      <SctyId><TckrSymb>${r.ticker}</TckrSymb></SctyId>
      <FinInstrmAttrbts>
        <OpnIntrst>${r.openInterest ?? '0'}</OpnIntrst>
        <FinInstrmQty>${r.volume ?? '0'}</FinInstrmQty>
        ${r.open === undefined ? '' : `<FrstPric Ccy="BRL">${r.open}</FrstPric>`}
        ${r.low === undefined ? '' : `<MinPric Ccy="BRL">${r.low}</MinPric>`}
        ${r.high === undefined ? '' : `<MaxPric Ccy="BRL">${r.high}</MaxPric>`}
        ${r.close === undefined ? '' : `<LastPric Ccy="BRL">${r.close}</LastPric>`}
        ${r.settlement === undefined ? '' : `<AdjstdQt Ccy="BRL">${r.settlement}</AdjstdQt>`}
      </FinInstrmAttrbts>
    </PricRpt>`,
  );
  return `<?xml version="1.0"?><Document>${blocks.join('')}</Document>`;
}

const WIN_RECORD = {
  ticker: 'WINV26',
  open: '172250',
  high: '175010',
  low: '171025',
  close: '174035',
  settlement: '173918',
  volume: '16797315',
  openInterest: '981391',
};

describe('scanning a price report', () => {
  it('pulls out only the instruments asked for', () => {
    const xml = priceReport([
      WIN_RECORD,
      { ticker: 'PETR4', open: '3800', high: '3850', low: '3790', close: '3820' },
      { ticker: 'WDOV26', open: '5400', high: '5430', low: '5390', close: '5410' },
    ]);
    const records = scanPriceReport(xml, (ticker) => ticker.startsWith('WIN'));
    expect(records.map((r) => r.ticker)).toEqual(['WINV26']);
  });

  it('reads every field the layout publishes', () => {
    const [record] = scanPriceReport(priceReport([WIN_RECORD]), () => true);
    expect(record).toEqual({
      ticker: 'WINV26',
      tradeDate: '2026-08-21',
      open: '172250',
      high: '175010',
      low: '171025',
      close: '174035',
      settlement: '173918',
      volume: '16797315',
      openInterest: '981391',
    });
  });

  it('scales to a report with thousands of instruments', () => {
    const many = Array.from({ length: 5_000 }, (_, i) => ({
      ticker: `SYM${String(i)}`,
      open: '100',
      high: '101',
      low: '99',
      close: '100',
    }));
    const records = scanPriceReport(priceReport([...many, WIN_RECORD]), (t) => t === 'WINV26');
    expect(records).toHaveLength(1);
  });

  it('returns nothing for a document with no price reports', () => {
    expect(scanPriceReport('<Document></Document>', () => true)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------- provider

function bulletinZip(xml: string): Buffer {
  const inner = makeZip([{ name: 'BVBG.086.01_BV0001.xml', data: Buffer.from(xml, 'utf8') }]);
  return makeZip([{ name: 'PR260821.zip', data: inner, store: true }]);
}

/** A provider wired to a scripted venue: the real code path, no network. */
function scripted(bodies: Map<string, Buffer | number>): B3DataProvider {
  return new B3DataProvider({
    requestDelayMs: 0,
    sleep: () => Promise.resolve(),
    fetch: (url) => {
      const name = /filelist=([^&]+)/.exec(url)?.[1] ?? '';
      const body = bodies.get(name);
      if (body === undefined || typeof body === 'number') {
        return Promise.resolve(
          new Response(null, { status: typeof body === 'number' ? body : 404 }),
        );
      }
      return Promise.resolve(new Response(new Uint8Array(body), { status: 200 }));
    },
  });
}

describe('naming a session file', () => {
  it("matches B3's PRyymmdd convention", () => {
    expect(bulletinName(fromIso('2026-08-21T15:00:00Z'))).toBe('PR260821.zip');
    expect(bulletinName(fromIso('2025-01-02T15:00:00Z'))).toBe('PR250102.zip');
  });

  it('lists only the sessions the venue was open', () => {
    // June 2025 has twenty trading days: four weekends and Corpus Christi on the 19th.
    const sessions = tradingSessionsBetween(
      calendar,
      fromIso('2025-06-01T00:00:00Z'),
      fromIso('2025-07-01T00:00:00Z'),
    );
    expect(sessions).toHaveLength(20);
  });
});

describe('the provider', () => {
  it('turns a session file into bars for the contracts requested', async () => {
    const bodies = new Map<string, Buffer | number>([
      [
        'PR260821.zip',
        bulletinZip(
          priceReport([
            WIN_RECORD,
            { ticker: 'PETR4', open: '1', high: '1', low: '1', close: '1' },
          ]),
        ),
      ],
    ]);
    const chunks = [];
    for await (const chunk of scripted(bodies).bars({
      symbol: 'WIN',
      timeframe: asDuration(86_400_000_000),
      from: fromIso('2026-08-21T00:00:00Z'),
      to: fromIso('2026-08-22T00:00:00Z'),
      contracts: ['WINV26'],
      calendar,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    const chunk = chunks[0]!;
    expect(chunk.count).toBe(1);
    // WIN quotes whole index points, so priceExp is 0 and the integers pass straight through.
    expect(chunk.open[0]).toBe(172_250);
    expect(chunk.high[0]).toBe(175_010);
    expect(chunk.low[0]).toBe(171_025);
    expect(chunk.close[0]).toBe(174_035);
    expect(chunk.volume[0]).toBe(16_797_315);
  });

  it('can take the settlement as the close instead of the last trade', async () => {
    const bodies = new Map<string, Buffer | number>([
      ['PR260821.zip', bulletinZip(priceReport([WIN_RECORD]))],
    ]);
    const chunks = [];
    for await (const chunk of scripted(bodies).bars({
      symbol: 'WIN',
      timeframe: asDuration(86_400_000_000),
      from: fromIso('2026-08-21T00:00:00Z'),
      to: fromIso('2026-08-22T00:00:00Z'),
      contracts: ['WINV26'],
      calendar,
      useSettlement: true,
    })) {
      chunks.push(chunk);
    }
    expect(chunks[0]?.close[0]).toBe(173_918);
  });

  it('drops a contract that settled without trading, rather than inventing a flat candle', async () => {
    // Open interest and a settlement, no open/high/low: this happened, but it is not a bar.
    const xml = priceReport([{ ticker: 'WINZ26', settlement: '174000', openInterest: '12' }]);
    const records = scanPriceReport(xml, () => true);
    expect(records[0]?.open).toBeNull();

    const bodies = new Map<string, Buffer | number>([['PR260821.zip', bulletinZip(xml)]]);
    const chunks = [];
    for await (const chunk of scripted(bodies).bars({
      symbol: 'WIN',
      timeframe: asDuration(86_400_000_000),
      from: fromIso('2026-08-21T00:00:00Z'),
      to: fromIso('2026-08-22T00:00:00Z'),
      contracts: ['WINZ26'],
      calendar,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });

  it('skips days the venue was shut without asking for them', async () => {
    let requests = 0;
    const provider = new B3DataProvider({
      requestDelayMs: 0,
      sleep: () => Promise.resolve(),
      fetch: () => {
        requests++;
        return Promise.resolve(
          new Response(new Uint8Array(bulletinZip(priceReport([WIN_RECORD]))), { status: 200 }),
        );
      },
    });
    const chunks = [];
    // A Friday to a Monday: two sessions, not four days.
    for await (const chunk of provider.bars({
      symbol: 'WIN',
      timeframe: asDuration(86_400_000_000),
      from: fromIso('2025-06-13T00:00:00Z'),
      to: fromIso('2025-06-17T00:00:00Z'),
      contracts: ['WINV26'],
      calendar,
    })) {
      chunks.push(chunk);
    }
    expect(requests).toBe(2);
  });

  it('gives up when the endpoint has stopped answering, instead of returning an empty series', async () => {
    const provider = new B3DataProvider({
      requestDelayMs: 0,
      sleep: () => Promise.resolve(),
      maxMissingSessions: 3,
      fetch: () => Promise.resolve(new Response(null, { status: 404 })),
    });
    await expect(async () => {
      for await (const _ of provider.bars({
        symbol: 'WIN',
        timeframe: asDuration(86_400_000_000),
        from: fromIso('2025-06-02T00:00:00Z'),
        to: fromIso('2025-07-01T00:00:00Z'),
        contracts: ['WINV26'],
        calendar,
      })) {
        void _;
      }
    }).rejects.toThrow(/probably changed/);
  });

  it('refuses a request that did not say which contracts it wants', () => {
    expect(() =>
      scripted(new Map()).bars({
        symbol: 'WIN',
        timeframe: asDuration(86_400_000_000),
        from: fromIso('2026-08-21T00:00:00Z'),
        to: fromIso('2026-08-22T00:00:00Z'),
      }),
    ).toThrow(/needs `contracts` and a `calendar`/);
  });

  it('knows the scales of the contracts it can fetch, and says when it does not', async () => {
    const provider = scripted(new Map());
    await expect(provider.describe('WIN')).resolves.toMatchObject({ priceExp: 0, tickSize: '5' });
    await expect(provider.describe('WDO')).resolves.toMatchObject({ priceExp: 1 });
    await expect(provider.describe('XYZ')).rejects.toThrow(/no instrument specification/);
  });

  it('reports an upstream failure rather than treating it as a holiday', async () => {
    const provider = new B3DataProvider({
      requestDelayMs: 0,
      sleep: () => Promise.resolve(),
      fetch: () => Promise.resolve(new Response(null, { status: 500 })),
    });
    await expect(provider.session(fromIso('2026-08-21T15:00:00Z'), () => true)).rejects.toThrow(
      UpstreamError,
    );
  });
});
