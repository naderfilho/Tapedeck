/**
 * The instruments the demo offers, and how a position is sized on them.
 *
 * Split from the run configuration so that `strategies.ts` can size a position without importing
 * the module that imports it. The circle is not hypothetical: a run needs a quantity, a quantity
 * needs an instrument, and an instrument is loaded per run.
 */

import { type BarChunk, type runBacktest } from '@tapedeck/core';
import { decodeBarTape } from '@tapedeck/data/codec';

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

/** The instrument type the engine accepts, derived rather than imported. See the note in `Tape`. */
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
 * `examples/sma-crossover/src/main.ts` sizes in BTC, `0.25`, which is how a human says it for one
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
