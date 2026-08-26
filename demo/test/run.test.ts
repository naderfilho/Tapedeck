/**
 * The site's own logic, tested where it is a program rather than a page.
 *
 * Three things here are not cosmetic. A run configuration arrives from a URL somebody can edit, so
 * `fromQuery` is a parser of untrusted input. The pairing of a market with a fee schedule is the
 * decision ADR-0017 records, and the only thing enforcing it is `presetsFor`. And the market list
 * is the one place the picker, the site build and the fixture script have to agree, so a row with
 * no tape behind it should fail here rather than as a 404 a visitor finds.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MARKETS, VENUES, marketById } from '../src/markets.ts';
import {
  DEFAULT_TIMEFRAME,
  type RunConfig,
  TIMEFRAMES,
  defaultPresetFor,
  describeConfig,
  executionFor,
  fromQuery,
  presetsFor,
  toQuery,
} from '../src/run.ts';

const BASE: RunConfig = {
  market: 'binance-BTCUSDT',
  timeframe: '1h',
  strategy: 'sma-crossover',
  params: { fastPeriod: 24, slowPeriod: 72, allowShort: true },
  notional: 25_000,
  preset: 'binanceSpot',
};

describe('the market list', () => {
  it('has a committed tape behind every row', () => {
    // The build throws on a missing fixture, which is late: this fails on the change that caused it.
    for (const market of MARKETS) {
      const path = fileURLToPath(new URL(`../../fixtures/${market.id}-1h.tape`, import.meta.url));
      expect(existsSync(path), `${market.id} has no fixture`).toBe(true);
    }
  });

  it('identifies a market by venue and symbol, never by symbol alone', () => {
    expect(new Set(MARKETS.map((m) => m.id)).size).toBe(MARKETS.length);
    // BTC is listed on both venues on purpose; the ids are what keep them apart.
    const bitcoin = MARKETS.filter((m) => m.ticker === 'BTC');
    expect(bitcoin.length).toBeGreaterThan(1);
    expect(new Set(bitcoin.map((m) => m.venue)).size).toBe(bitcoin.length);
  });

  it('resolves a link shared before the second venue existed', () => {
    expect(marketById('BTCUSDT')?.id).toBe('binance-BTCUSDT');
    expect(marketById('binance-BTCUSDT')?.id).toBe('binance-BTCUSDT');
    expect(marketById('BTC-USD')).toBeUndefined();
    expect(marketById('nonsense')).toBeUndefined();
  });
});

describe('cost presets follow the venue', () => {
  it('never offers one exchange schedule against another exchange tape', () => {
    for (const market of MARKETS) {
      const allowed = presetsFor(market.id);
      const others = Object.values(VENUES)
        .filter((venue) => venue.id !== market.venue)
        .flatMap((venue) => venue.presets);
      for (const foreign of others) expect(allowed).not.toContain(foreign);
    }
  });

  it('offers the venue-neutral settings everywhere', () => {
    for (const market of MARKETS) {
      expect(presetsFor(market.id)).toContain('ideal');
      expect(presetsFor(market.id)).toContain('stress');
      expect(presetsFor(market.id)).toContain(defaultPresetFor(market.id));
    }
  });

  it('opens a market on its own venue schedule', () => {
    expect(defaultPresetFor('binance-BTCUSDT')).toBe('binanceSpot');
    expect(defaultPresetFor('coinbase-BTC-USD')).toBe('coinbaseExchange');
  });

  it('keeps the venue fee under the stress setting and only worsens the fill', () => {
    // Stress is a what-if about execution, not an invented fee schedule. Inventing a worse fee
    // would be the same failure as inventing a better one.
    const venue = executionFor('coinbaseExchange', 'coinbaseExchange');
    const stressed = executionFor('stress', 'coinbaseExchange');
    expect(stressed.commission.name).toBe(venue.commission.name);
    expect(stressed.slippage.name).not.toBe(venue.slippage.name);
    expect(stressed.liquidity.name).not.toBe(venue.liquidity.name);
  });

  it('charges nothing under the flattering setting', () => {
    expect(executionFor('ideal', 'binanceSpot').commission.name).toBe('none');
  });
});

describe('a run travels as a URL', () => {
  it('round-trips every field', () => {
    const parsed = fromQuery(`?${toQuery(BASE)}`);
    expect(parsed).toEqual(BASE);
  });

  it('round-trips a run on the other venue and a slower clock', () => {
    const config: RunConfig = {
      ...BASE,
      market: 'coinbase-BTC-USD',
      timeframe: '1d',
      preset: 'coinbaseExchange',
    };
    expect(fromQuery(`?${toQuery(config)}`)).toEqual(config);
  });

  it('reads a link shared before timeframes existed as the hourly one it was', () => {
    const parsed = fromQuery('?symbol=BTCUSDT&strategy=sma-crossover&size=25000&costs=binanceSpot');
    expect(parsed?.market).toBe('binance-BTCUSDT');
    expect(parsed?.timeframe).toBe(DEFAULT_TIMEFRAME);
  });

  it('refuses a preset that belongs to another venue rather than quietly swapping it', () => {
    // A repaired link renders a run nobody asked for, and nothing on the page would say so.
    const query = toQuery(BASE).replace('symbol=binance-BTCUSDT', 'symbol=coinbase-BTC-USD');
    expect(fromQuery(`?${query}`)).toBeNull();
  });

  it('refuses anything else it cannot make sense of', () => {
    const cases = [
      '',
      '?symbol=nonsense&strategy=sma-crossover&size=25000&costs=binanceSpot',
      `?${toQuery(BASE).replace('tf=1h', 'tf=90m')}`,
      `?${toQuery(BASE).replace('strategy=sma-crossover', 'strategy=telepathy')}`,
      `?${toQuery(BASE).replace('size=25000', 'size=-1')}`,
      `?${toQuery(BASE).replace('size=25000', 'size=abc')}`,
      `?${toQuery(BASE).replace('costs=binanceSpot', 'costs=free')}`,
      // Below the strategy's own minimum for a moving-average period.
      `?${toQuery(BASE).replace('p.fastPeriod=24', 'p.fastPeriod=1')}`,
      `?${toQuery(BASE).replace('p.fastPeriod=24', 'p.fastPeriod=2.5')}`,
      `?${toQuery(BASE).replace('p.allowShort=1', 'p.allowShort=yes')}`,
    ];
    for (const query of cases) expect(fromQuery(query), query).toBeNull();
  });

  it('fills in a parameter the link omits with the strategy default', () => {
    const query = toQuery(BASE)
      .split('&')
      .filter((part) => !part.startsWith('p.slowPeriod'))
      .join('&');
    expect(fromQuery(`?${query}`)?.params['slowPeriod']).toBe(72);
  });

  it('accepts every timeframe the picker offers', () => {
    for (const frame of TIMEFRAMES) {
      const query = toQuery({ ...BASE, timeframe: frame.id });
      expect(fromQuery(`?${query}`)?.timeframe).toBe(frame.id);
    }
  });
});

describe('describeConfig', () => {
  it('names the venue, the clock, the size in the market currency and the fee schedule', () => {
    const text = describeConfig({
      ...BASE,
      market: 'coinbase-BTC-USD',
      preset: 'coinbaseExchange',
    });
    expect(text).toContain('Coinbase');
    expect(text).toContain('1h');
    expect(text).toContain('25,000 USD');
    expect(text).toContain('0.60%');
    // USDT is not USD, and a Coinbase run must not say it is.
    expect(text).not.toContain('USDT');
  });
});
