/**
 * Instrument definitions.
 *
 * An instrument carries the scales that make every other number in the engine meaningful: how many
 * decimals a price has, how many a quantity has, how much money one price point is worth. There is
 * no default precision anywhere in Tapedeck (ADR-0002) — if it is not declared here, it does not
 * exist.
 *
 * Specs are written with decimal *strings* so that a definition file reads like the exchange's own
 * contract sheet and no float ever participates in the conversion.
 */

import type { Brand } from './util/brand.ts';
import { ConfigError, NotFoundError } from './util/errors.ts';
import {
  type MoneyInt,
  type PriceInt,
  type QtyInt,
  MONEY_EXP,
  asMoney,
  asPrice,
  asQty,
  parseFixed,
} from './math/fixed.ts';

export type Venue = string;
export type Currency = string;
export type InstrumentKind = 'future' | 'stock' | 'spot' | 'option';

/**
 * How buying affects cash.
 *
 * - `cash` — spot and stocks: a purchase spends cash and the position is worth its market value.
 * - `margin` — futures: a purchase spends only commission, blocks margin, and the position is
 *   worth its unrealised PnL.
 *
 * Both settle to the same equity identity, which is what the portfolio property tests assert:
 * `equity == initialCash + realised + unrealised - commission`.
 */
export type AccountingMode = 'cash' | 'margin';

/** Dense index into the {@link InstrumentRegistry}. Keeps per-instrument lookups array-indexed. */
export type InstrumentId = Brand<number, 'InstrumentId'>;

export interface InstrumentSpec {
  readonly symbol: string;
  readonly venue: Venue;
  readonly kind: InstrumentKind;
  readonly currency: Currency;
  /** Decimals carried by a price. `WIN` quotes whole index points, so 0. */
  readonly priceExp: number;
  /** Decimals carried by a quantity. Futures trade whole contracts, so 0. */
  readonly qtyExp: number;
  /** Minimum price increment as a decimal string, e.g. `"0.01"` or `"5"`. */
  readonly tickSize: string;
  /** Minimum tradable quantity as a decimal string. */
  readonly lotSize: string;
  /** Money value of one full price point, as a decimal string. `"1"` for spot and stocks. */
  readonly pointValue: string;
  /** Defaults to `margin` for futures and `cash` for everything else. */
  readonly accounting?: AccountingMode | undefined;
  /** Initial margin per unit of quantity, decimal string. Futures only. */
  readonly initialMargin?: string | undefined;
}

export interface Instrument {
  readonly id: InstrumentId;
  readonly symbol: string;
  readonly venue: Venue;
  readonly kind: InstrumentKind;
  readonly currency: Currency;
  readonly priceExp: number;
  readonly qtyExp: number;
  readonly tickSize: PriceInt;
  readonly lotSize: QtyInt;
  readonly pointValue: MoneyInt;
  readonly accounting: AccountingMode;
  readonly initialMargin: MoneyInt;
  /** `10 ** (priceExp + qtyExp)`: the divisor that turns `price * qty * pointValue` into money. */
  readonly notionalDivisor: number;
  /** `venue:symbol`, the registry key. */
  readonly key: string;
}

function requirePositive(value: number, field: string, symbol: string): number {
  if (!(value > 0)) {
    throw new ConfigError(`${symbol}: ${field} must be greater than zero`, {
      symbol,
      field,
      value,
    });
  }
  return value;
}

function requireExp(value: number, field: string, symbol: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 15) {
    throw new ConfigError(`${symbol}: ${field} must be an integer between 0 and 15`, {
      symbol,
      field,
      value,
    });
  }
  return value;
}

/** Resolves a spec into an instrument. `id` is assigned by the registry, not by the caller. */
export function resolveInstrument(spec: InstrumentSpec, id: InstrumentId): Instrument {
  const symbol = spec.symbol.trim();
  if (symbol === '') throw new ConfigError('instrument symbol must not be empty');
  const priceExp = requireExp(spec.priceExp, 'priceExp', symbol);
  const qtyExp = requireExp(spec.qtyExp, 'qtyExp', symbol);
  const notionalDivisor = 10 ** (priceExp + qtyExp);
  if (!Number.isSafeInteger(notionalDivisor)) {
    throw new ConfigError(`${symbol}: priceExp + qtyExp is too large`, {
      symbol,
      priceExp,
      qtyExp,
    });
  }

  return {
    id,
    symbol,
    venue: spec.venue,
    kind: spec.kind,
    currency: spec.currency,
    priceExp,
    qtyExp,
    tickSize: asPrice(requirePositive(parseFixed(spec.tickSize, priceExp), 'tickSize', symbol)),
    lotSize: asQty(requirePositive(parseFixed(spec.lotSize, qtyExp), 'lotSize', symbol)),
    pointValue: asMoney(
      requirePositive(parseFixed(spec.pointValue, MONEY_EXP), 'pointValue', symbol),
    ),
    accounting: spec.accounting ?? (spec.kind === 'future' ? 'margin' : 'cash'),
    initialMargin: asMoney(
      spec.initialMargin === undefined ? 0 : parseFixed(spec.initialMargin, MONEY_EXP),
    ),
    notionalDivisor,
    key: `${spec.venue}:${symbol}`,
  };
}

/**
 * Registry of the instruments a run may trade.
 *
 * Ids are assigned in registration order, which makes them stable across runs of the same
 * configuration — a precondition for the determinism guarantee.
 */
export class InstrumentRegistry {
  private readonly list: Instrument[] = [];
  private readonly byKey = new Map<string, Instrument>();

  get size(): number {
    return this.list.length;
  }

  register(spec: InstrumentSpec): Instrument {
    const instrument = resolveInstrument(spec, this.list.length as InstrumentId);
    if (this.byKey.has(instrument.key)) {
      throw new ConfigError(`instrument already registered: ${instrument.key}`, {
        key: instrument.key,
      });
    }
    this.list.push(instrument);
    this.byKey.set(instrument.key, instrument);
    return instrument;
  }

  /** Array-indexed lookup used on the hot path. */
  byId(id: InstrumentId): Instrument {
    const instrument = this.list[id];
    if (instrument === undefined) {
      throw new NotFoundError(`no instrument with id ${String(id)}`, { id });
    }
    return instrument;
  }

  find(venue: Venue, symbol: string): Instrument | undefined {
    return this.byKey.get(`${venue}:${symbol}`);
  }

  require(venue: Venue, symbol: string): Instrument {
    const instrument = this.find(venue, symbol);
    if (instrument === undefined) {
      throw new NotFoundError(`no instrument registered as ${venue}:${symbol}`, { venue, symbol });
    }
    return instrument;
  }

  all(): readonly Instrument[] {
    return this.list;
  }
}

/**
 * Reference specs.
 *
 * The margin figures are placeholders: B3 revises them, and a backtest that silently uses a stale
 * margin requirement reports a leverage that never existed. Override them per run.
 */
export const INSTRUMENTS = {
  /** Mini Ibovespa future. One point is R$0.20; the tick is 5 points. */
  WIN: {
    symbol: 'WIN',
    venue: 'B3',
    kind: 'future',
    currency: 'BRL',
    priceExp: 0,
    qtyExp: 0,
    tickSize: '5',
    lotSize: '1',
    pointValue: '0.20',
    accounting: 'margin',
    initialMargin: '1000',
  },
  /** Mini US dollar future. One point is R$10.00; the tick is half a point. */
  WDO: {
    symbol: 'WDO',
    venue: 'B3',
    kind: 'future',
    currency: 'BRL',
    priceExp: 1,
    qtyExp: 0,
    tickSize: '0.5',
    lotSize: '1',
    pointValue: '10',
    accounting: 'margin',
    initialMargin: '1500',
  },
  /** Binance spot BTC/USDT. */
  BTCUSDT: {
    symbol: 'BTCUSDT',
    venue: 'BINANCE',
    kind: 'spot',
    currency: 'USDT',
    priceExp: 2,
    qtyExp: 8,
    tickSize: '0.01',
    lotSize: '0.00001',
    pointValue: '1',
    accounting: 'cash',
  },
} as const satisfies Readonly<Record<string, InstrumentSpec>>;

/** A B3 cash-equity spec: R$0.01 tick, whole shares, one point is one real. */
export function b3Stock(symbol: string): InstrumentSpec {
  return {
    symbol,
    venue: 'B3',
    kind: 'stock',
    currency: 'BRL',
    priceExp: 2,
    qtyExp: 0,
    tickSize: '0.01',
    lotSize: '1',
    pointValue: '1',
    accounting: 'cash',
  };
}
