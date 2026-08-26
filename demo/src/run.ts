/**
 * One definition of a run, shared by the demo and the report.
 *
 * These two pages have to agree exactly. If the demo derives a quantity one way and the report
 * derives it another, the report shows different numbers for the run it claims to describe, and the
 * page that exists to prove the engine is deterministic becomes the page that disproves it. So the
 * configuration, the sizing, the seed and the execution preset all live here and neither page owns
 * a copy.
 *
 * A run travels between pages as its **configuration**, never as its result. The engine is
 * deterministic: the same parameters over the same committed tape produce the same equity curve on
 * any machine, so the receiving page recomputes rather than being told. That makes a report URL
 * shareable, and it means a stale link cannot show a number the engine would no longer produce.
 */

import { type BarChunk, PRESETS, type RunResult, runBacktest } from '@tapedeck/core';
import { decodeBarTape } from '@tapedeck/data/codec';
import smaCrossover from '../../examples/sma-crossover/src/strategy.ts';

export const INITIAL_CASH = '100000';

/** Fixed, and part of the contract: the same seed is why two machines agree to the cent. */
export const SEED = 20_260_825;

export const MARKETS = [
  { symbol: 'BTCUSDT', name: 'Bitcoin', ticker: 'BTC' },
  { symbol: 'ETHUSDT', name: 'Ethereum', ticker: 'ETH' },
  { symbol: 'SOLUSDT', name: 'Solana', ticker: 'SOL' },
  { symbol: 'BNBUSDT', name: 'BNB', ticker: 'BNB' },
  { symbol: 'XRPUSDT', name: 'XRP', ticker: 'XRP' },
] as const;

export type MarketSymbol = (typeof MARKETS)[number]['symbol'];

const SYMBOLS = new Set<string>(MARKETS.map((m) => m.symbol));

export const isMarketSymbol = (value: string): value is MarketSymbol => SYMBOLS.has(value);

export const tickerFor = (symbol: string): string =>
  MARKETS.find((m) => m.symbol === symbol)?.ticker ?? symbol.replace('USDT', '');

export const nameFor = (symbol: string): string =>
  MARKETS.find((m) => m.symbol === symbol)?.name ?? symbol;

/** The instrument type the engine accepts, derived rather than imported — see the note in `Tape`. */
type InstrumentInput = Parameters<typeof runBacktest>[0]['instruments'][number];

export interface Tape {
  /**
   * Derived from `runBacktest` rather than imported, because what a tape decodes to is the *spec*
   * the engine accepts, not the resolved `Instrument` it builds internally. Naming the concrete
   * type compiled right up until the engine added a field to it.
   */
  readonly instrument: InstrumentInput;
  readonly chunk: BarChunk;
}

export interface RunConfig {
  readonly symbol: MarketSymbol;
  readonly fastPeriod: number;
  readonly slowPeriod: number;
  /** Position size in quote currency (USDT). See `quantityFor`. */
  readonly notional: number;
  readonly preset: 'ideal' | 'binanceSpot';
  readonly allowShort: boolean;
}

/**
 * The example's size, in coins, so an unparameterised page opens on the published run.
 *
 * `examples/sma-crossover/src/main.ts` sizes in BTC — `0.25`, which is how a human says it for one
 * instrument. A page offering five cannot: 0.25 is a different amount of money on every tape.
 */
export const EXAMPLE_SIZE_COINS = 0.25;
export const EXAMPLE_SYMBOL: MarketSymbol = 'BTCUSDT';

/**
 * Turns a position size in USDT into the integer quantity the engine deals in.
 *
 * A raw quantity stopped meaning anything the moment there was a second instrument: `25000` is
 * 0.25 BTC on a tape reporting five decimals and 2,500 XRP on one reporting a single decimal.
 */
export function quantityFor(tape: Tape, notionalUsdt: number): number {
  const price = (tape.chunk.close[0] ?? 0) / 10 ** tape.instrument.priceExp;
  if (price <= 0) return 0;
  const coins = notionalUsdt / price;
  // Every tape here reports a lot size of exactly one unit at its own precision, so rounding to an
  // integer is the lot-size snap. `Math.max` keeps a tiny size legal rather than submitting a
  // zero-quantity order the engine would refuse.
  return Math.max(1, Math.round(coins * 10 ** tape.instrument.qtyExp));
}

export function describeQuantity(tape: Tape, qty: number): string {
  const coins = qty / 10 ** tape.instrument.qtyExp;
  const digits = Math.min(tape.instrument.qtyExp, coins < 1 ? 4 : 2);
  return `${coins.toLocaleString('en-US', { maximumFractionDigits: digits })} ${tickerFor(tape.instrument.symbol)}`;
}

const tapes = new Map<MarketSymbol, Tape>();

/** Fetches and decodes a tape, once. `base` differs per page depth (`tapes/` vs `../demo/tapes/`). */
export async function loadTape(symbol: MarketSymbol, base: string): Promise<Tape> {
  const cached = tapes.get(symbol);
  if (cached !== undefined) return cached;

  const response = await fetch(`${base}${symbol}-1h.tape`);
  if (!response.ok) {
    throw new Error(`could not load the tape for ${symbol}: ${String(response.status)}`);
  }
  const file = decodeBarTape(new Uint8Array(await response.arrayBuffer()));
  const tape: Tape = { instrument: file.instrument, chunk: file.chunk };
  tapes.set(symbol, tape);
  return tape;
}

/** The single place a backtest is constructed. Both pages call this and nothing else. */
export function execute(tape: Tape, config: RunConfig): RunResult {
  return runBacktest(
    {
      instruments: [tape.instrument],
      strategy: smaCrossover,
      params: {
        fastPeriod: config.fastPeriod,
        slowPeriod: config.slowPeriod,
        qty: quantityFor(tape, config.notional),
        allowShort: config.allowShort,
      },
      initialCash: INITIAL_CASH,
      seed: SEED,
      execution: PRESETS[config.preset](),
      flattenAtEnd: true,
      // The guarded bar view costs about half the throughput and exists to catch a strategy that
      // keeps the bar. Neither page's strategy does, and speed is part of the demonstration.
      barViewMode: 'reuse',
    },
    [tape.chunk],
  );
}

// -------------------------------------------------------------------------- travelling as a URL

export function toQuery(config: RunConfig): string {
  const params = new URLSearchParams({
    symbol: config.symbol,
    fast: String(config.fastPeriod),
    slow: String(config.slowPeriod),
    size: String(config.notional),
    costs: config.preset,
    short: config.allowShort ? '1' : '0',
  });
  return params.toString();
}

function boundedInt(raw: string | null, min: number, max: number): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

/**
 * Reads a configuration out of a query string, or returns `null` if anything is off.
 *
 * Every field is validated against the same bounds the form enforces, because this input arrives
 * from a URL somebody can edit. `null` rather than a thrown error or a repaired object: a page that
 * silently corrects a link renders a report for a run nobody asked for, and the reader has no way
 * to tell it happened.
 */
export function fromQuery(search: string): RunConfig | null {
  const params = new URLSearchParams(search);
  const symbol = params.get('symbol');
  if (symbol === null || !isMarketSymbol(symbol)) return null;

  const fastPeriod = boundedInt(params.get('fast'), 2, 200);
  const slowPeriod = boundedInt(params.get('slow'), 3, 400);
  if (fastPeriod === null || slowPeriod === null || fastPeriod >= slowPeriod) return null;

  const notional = Number(params.get('size'));
  if (!Number.isFinite(notional) || notional <= 0 || notional > 1e12) return null;

  const preset = params.get('costs');
  if (preset !== 'ideal' && preset !== 'binanceSpot') return null;

  const short = params.get('short');
  if (short !== '0' && short !== '1') return null;

  return { symbol, fastPeriod, slowPeriod, notional, preset, allowShort: short === '1' };
}

/** How a run reads in a sentence, for a page heading. */
export function describeConfig(config: RunConfig): string {
  const costs = config.preset === 'ideal' ? 'no costs' : 'Binance spot costs';
  return (
    `${nameFor(config.symbol)} · ${String(config.fastPeriod)}/${String(config.slowPeriod)} crossover · ` +
    `${config.notional.toLocaleString('en-US')} USDT · ${costs}` +
    (config.allowShort ? '' : ' · long only')
  );
}
