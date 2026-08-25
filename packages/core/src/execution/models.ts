/**
 * The four models that make a simulated fill something other than a wish: slippage, commission,
 * latency and available liquidity.
 *
 * They are separate interfaces because they answer separate questions, and because a venue preset
 * should be a composition of four honest parts rather than a switch statement inside the broker.
 *
 * Every proportional parameter is expressed in **basis points as an integer**, never as a float
 * fraction. `mulDiv` then makes the arithmetic exact, and two runs on two machines cannot disagree
 * about the last unit of a commission.
 */

import type { Instrument } from '../instrument.ts';
import {
  type MoneyInt,
  type PriceInt,
  type QtyInt,
  MONEY_EXP,
  asMoney,
  asPrice,
  asQty,
  mulDiv,
  mulMulDiv,
  parseFixed,
  roundToTick,
} from '../math/fixed.ts';
import type { Rng } from '../util/rng.ts';
import { ConfigError } from '../util/errors.ts';
import type { Liquidity, OrderType, Side } from './types.ts';

const BPS_DIVISOR = 10_000;

/** How the engine resolves a bar in which more than one resting order could have filled. */
export type IntrabarPolicy = 'pessimistic' | 'optimistic' | 'ohlc-path';

export interface SlippageContext {
  readonly instrument: Instrument;
  readonly side: Side;
  readonly type: OrderType;
  readonly qty: QtyInt;
  /** Price before slippage: the bar open, the trigger price or the limit price. */
  readonly referencePrice: PriceInt;
  readonly liquidity: Liquidity;
  /** `high - low` of the bar being matched; `0` when matching a tick. */
  readonly barRange: PriceInt;
  readonly rng: Rng;
}

export interface SlippageModel {
  readonly name: string;
  /** Returns the executed price. Implementations must move it *against* the taker. */
  apply(ctx: SlippageContext): PriceInt;
}

export interface CommissionContext {
  readonly instrument: Instrument;
  readonly side: Side;
  readonly qty: QtyInt;
  readonly price: PriceInt;
  /** `price * qty * pointValue`, already computed by the broker. Always positive. */
  readonly notional: MoneyInt;
  readonly liquidity: Liquidity;
}

export interface CommissionModel {
  readonly name: string;
  /** Always returns a non-negative charge. */
  charge(ctx: CommissionContext): MoneyInt;
}

export interface LatencyModel {
  readonly name: string;
  /** Microseconds between a strategy submitting an order and the order becoming matchable. */
  delayMicros(rng: Rng): number;
}

export interface LiquidityContext {
  readonly instrument: Instrument;
  /** Quantity the order still wants. */
  readonly remainingQty: QtyInt;
  /** Volume printed by the bar being matched. `0` means unknown. */
  readonly barVolume: QtyInt;
}

export interface LiquidityModel {
  readonly name: string;
  /** Upper bound on what this order may take from this bar. Returning `0` defers the fill. */
  maxFillQty(ctx: LiquidityContext): QtyInt;
}

/** The direction a taker's price moves when it is wrong. */
function penaltyDirection(side: Side): number {
  return side === 'buy' ? 1 : -1;
}

export function noSlippage(): SlippageModel {
  return {
    name: 'none',
    apply: (ctx) => ctx.referencePrice,
  };
}

/** Costs the taker a whole number of ticks. The model to use when in doubt about a futures book. */
export function fixedTicksSlippage(ticks: number): SlippageModel {
  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new ConfigError('slippage ticks must be a non-negative integer', { ticks });
  }
  return {
    name: `fixed-ticks(${String(ticks)})`,
    apply: (ctx) => {
      if (ctx.liquidity === 'maker' || ticks === 0) return ctx.referencePrice;
      const offset = ticks * ctx.instrument.tickSize * penaltyDirection(ctx.side);
      return asPrice(ctx.referencePrice + offset);
    },
  };
}

/** Costs the taker a share of the price. Natural fit for crypto, where the tick is tiny. */
export function bpsSlippage(bps: number): SlippageModel {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new ConfigError('slippage bps must be a non-negative integer', { bps });
  }
  return {
    name: `bps(${String(bps)})`,
    apply: (ctx) => {
      if (ctx.liquidity === 'maker' || bps === 0) return ctx.referencePrice;
      const offset =
        mulDiv(ctx.referencePrice, bps, BPS_DIVISOR, 'ceil') * penaltyDirection(ctx.side);
      const raw = ctx.referencePrice + offset;
      const direction = ctx.side === 'buy' ? 'up' : 'down';
      return asPrice(roundToTick(raw, ctx.instrument.tickSize, direction));
    },
  };
}

/**
 * Costs the taker a share of the bar's own range, so a violent bar is expensive and a quiet one is
 * cheap. Closer to how a market order actually behaves than a constant.
 */
export function rangeFractionSlippage(bps: number): SlippageModel {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new ConfigError('slippage bps must be a non-negative integer', { bps });
  }
  return {
    name: `range-fraction(${String(bps)})`,
    apply: (ctx) => {
      if (ctx.liquidity === 'maker' || bps === 0 || ctx.barRange === 0) return ctx.referencePrice;
      const offset = mulDiv(ctx.barRange, bps, BPS_DIVISOR, 'ceil') * penaltyDirection(ctx.side);
      const direction = ctx.side === 'buy' ? 'up' : 'down';
      return asPrice(roundToTick(ctx.referencePrice + offset, ctx.instrument.tickSize, direction));
    },
  };
}

/**
 * Adds `0..maxExtraTicks` of random extra cost on top of another model.
 *
 * The draw comes from the injected {@link Rng}, so it is part of the reproducible run, not noise
 * (ADR-0006). Use it to see how sensitive a strategy is to execution quality.
 */
export function withJitter(base: SlippageModel, maxExtraTicks: number): SlippageModel {
  if (!Number.isInteger(maxExtraTicks) || maxExtraTicks < 0) {
    throw new ConfigError('maxExtraTicks must be a non-negative integer', { maxExtraTicks });
  }
  return {
    name: `${base.name}+jitter(${String(maxExtraTicks)})`,
    apply: (ctx) => {
      const price = base.apply(ctx);
      if (ctx.liquidity === 'maker' || maxExtraTicks === 0) return price;
      const extra = ctx.rng.nextInt(0, maxExtraTicks + 1);
      return asPrice(price + extra * ctx.instrument.tickSize * penaltyDirection(ctx.side));
    },
  };
}

export function noCommission(): CommissionModel {
  return { name: 'none', charge: () => asMoney(0) };
}

/**
 * A flat charge per unit of quantity — per contract for futures, per share for equities.
 * `amount` is a decimal string in the instrument's currency.
 */
export function perUnitCommission(amount: string): CommissionModel {
  const perUnit = parseFixed(amount, MONEY_EXP);
  if (perUnit < 0) throw new ConfigError('commission must not be negative', { amount });
  return {
    name: `per-unit(${amount})`,
    charge: (ctx) => asMoney(mulDiv(perUnit, ctx.qty, 10 ** ctx.instrument.qtyExp, 'half-up')),
  };
}

export interface BpsCommissionOptions {
  readonly makerBps: number;
  readonly takerBps: number;
  /** Floor per fill, as a decimal string. Binance has none; several brokers do. */
  readonly minimum?: string | undefined;
}

/** A share of notional, the shape used by nearly every crypto venue. */
export function bpsCommission(options: BpsCommissionOptions): CommissionModel {
  const { makerBps, takerBps } = options;
  if (makerBps < 0 || takerBps < 0) throw new ConfigError('commission bps must not be negative');
  const minimum = options.minimum === undefined ? 0 : parseFixed(options.minimum, MONEY_EXP);
  return {
    name: `bps(maker=${String(makerBps)},taker=${String(takerBps)})`,
    charge: (ctx) => {
      const bps = ctx.liquidity === 'maker' ? makerBps : takerBps;
      const fee = mulDiv(ctx.notional, bps, BPS_DIVISOR, 'half-up');
      return asMoney(Math.max(fee, minimum));
    },
  };
}

/**
 * A B3 tariff as the exchange publishes it.
 *
 * B3 charges **one unit cost per contract** and apportions it internally between emoluments and
 * the registration fee; the split is an invoice detail and the sum is what reaches the ledger, so
 * this models the sum. Two structural facts that a flat number in reais cannot express:
 *
 * - **The dollar contracts are priced in dollars.** WDO costs US$0.12 per contract, not a fixed
 *   amount of reais, so its cost in BRL moves with the exchange rate. {@link B3FuturesCostOptions}
 *   therefore demands a rate for those contracts and refuses to guess one.
 * - **The day-trade reduction is a volume band, not a number.** It runs 35% to 75% on the index
 *   family and 16% to 65% on the dollar family, by the trader's own average daily volume. The
 *   figure here is the *lowest* band — the smallest discount, the highest cost — because that is
 *   the retail case and the pessimistic one.
 *
 * The published prices already include PIS, COFINS and ISS.
 */
export interface B3Tariff {
  readonly contract: string;
  /** Unit cost per contract, as a decimal string in {@link currency}. */
  readonly unitCost: string;
  readonly currency: 'BRL' | 'USD';
  /** Reduction applied to the unit cost on a day trade, in basis points of the cost. */
  readonly dayTradeReductionBps: number;
  /** Where the figure came from, so it can be re-checked rather than trusted. */
  readonly source: string;
  /** The day it was transcribed. B3 revises these without notice; treat it as a reading, not a law. */
  readonly readOn: string;
}

/**
 * B3 futures tariffs, transcribed from the exchange's own published tables.
 *
 * These are citations, not invention — but a citation with a date on it, and B3 changes them. The
 * volume bands are collapsed to the retail end on purpose (see {@link B3Tariff}), so a desk trading
 * size pays less than this says. If the numbers matter to your conclusion, open the source URL and
 * check them; if they have moved, `breakEvenCommissionPerUnit` in `@tapedeck/report` tells you
 * whether the move is large enough to change the answer.
 */
export const B3_TARIFFS = {
  /** Ibovespa mini future. */
  WIN: {
    contract: 'WIN',
    unitCost: '0.30',
    currency: 'BRL',
    dayTradeReductionBps: 3_500,
    source:
      'https://www.b3.com.br/pt_br/produtos-e-servicos/tarifas/listados-a-vista-e-derivativos/renda-variavel/tarifas-de-ibovespa-e-indice-brasil-50/futuros-e-estruturadas/',
    readOn: '2026-08-25',
  },
  /** Ibovespa full-size future. */
  IND: {
    contract: 'IND',
    unitCost: '1.52',
    currency: 'BRL',
    dayTradeReductionBps: 3_500,
    source:
      'https://www.b3.com.br/pt_br/produtos-e-servicos/tarifas/listados-a-vista-e-derivativos/renda-variavel/tarifas-de-ibovespa-e-indice-brasil-50/futuros-e-estruturadas/',
    readOn: '2026-08-25',
  },
  /** US dollar mini future. Priced in dollars: the cost in reais moves with the rate. */
  WDO: {
    contract: 'WDO',
    unitCost: '0.12',
    currency: 'USD',
    dayTradeReductionBps: 1_600,
    source:
      'https://www.b3.com.br/pt_br/produtos-e-servicos/tarifas/listados-a-vista-e-derivativos/moedas/tarifas-de-dolar-dos-estados-unidos/futuros-de-dolar/',
    readOn: '2026-08-25',
  },
  /** US dollar full-size future. */
  DOL: {
    contract: 'DOL',
    unitCost: '0.60',
    currency: 'USD',
    dayTradeReductionBps: 1_600,
    source:
      'https://www.b3.com.br/pt_br/produtos-e-servicos/tarifas/listados-a-vista-e-derivativos/moedas/tarifas-de-dolar-dos-estados-unidos/futuros-de-dolar/',
    readOn: '2026-08-25',
  },
} as const satisfies Readonly<Record<string, B3Tariff>>;

export interface B3FuturesCostOptions {
  readonly tariff: B3Tariff;
  /** Applies the day-trade reduction. Defaults to false, which is the more expensive case. */
  readonly dayTrade?: boolean | undefined;
  /**
   * Broker commission per contract, as a decimal string in BRL. Defaults to `'0'`, which is what
   * several Brazilian brokers charge on minis — and unlike a zero *exchange* fee, it is a real
   * configuration rather than a flattering omission.
   */
  readonly brokerage?: string | undefined;
  /** BRL per USD. Required for a dollar-denominated tariff, refused for a real-denominated one. */
  readonly usdBrl?: string | undefined;
}

/**
 * B3 futures costs: the exchange's unit cost, the day-trade reduction, and your broker's charge.
 *
 * The model's `name` carries every input, so a report always says which tariff, which discount and
 * which exchange rate produced a currency amount.
 */
export function b3FuturesCommission(options: B3FuturesCostOptions): CommissionModel {
  const { tariff } = options;
  const dayTrade = options.dayTrade ?? false;
  const brokerage = options.brokerage ?? '0';

  let exchange = parseFixed(tariff.unitCost, MONEY_EXP);
  if (tariff.currency === 'USD') {
    if (options.usdBrl === undefined) {
      throw new ConfigError(
        `${tariff.contract} is priced in USD (US$${tariff.unitCost} per contract), so its cost in ` +
          `reais depends on the exchange rate. Pass usdBrl rather than letting the engine invent one.`,
        { contract: tariff.contract },
      );
    }
    exchange = mulDiv(exchange, parseFixed(options.usdBrl, MONEY_EXP), 10 ** MONEY_EXP, 'half-up');
  } else if (options.usdBrl !== undefined) {
    throw new ConfigError(`${tariff.contract} is priced in BRL; usdBrl does not apply to it`, {
      contract: tariff.contract,
    });
  }

  if (dayTrade) {
    exchange = exchange - mulDiv(exchange, tariff.dayTradeReductionBps, BPS_DIVISOR, 'half-up');
  }

  const perContract = exchange + parseFixed(brokerage, MONEY_EXP);
  if (perContract < 0) throw new ConfigError('B3 cost components must not be negative');

  const rate = options.usdBrl === undefined ? '' : `@${options.usdBrl}`;
  return {
    name:
      `b3(${tariff.contract} ${tariff.unitCost}${tariff.currency}${rate}` +
      `${dayTrade ? ' dt' : ''}+brokerage ${brokerage})`,
    charge: (ctx) => asMoney(mulDiv(perContract, ctx.qty, 10 ** ctx.instrument.qtyExp, 'half-up')),
  };
}

export function noLatency(): LatencyModel {
  return { name: 'none', delayMicros: () => 0 };
}

export function fixedLatency(micros: number): LatencyModel {
  if (!Number.isInteger(micros) || micros < 0) {
    throw new ConfigError('latency must be a non-negative integer number of microseconds', {
      micros,
    });
  }
  return { name: `fixed(${String(micros)}us)`, delayMicros: () => micros };
}

/** Uniform latency in `[minMicros, maxMicros]`, drawn from the run's seeded stream. */
export function uniformLatency(minMicros: number, maxMicros: number): LatencyModel {
  if (!Number.isInteger(minMicros) || !Number.isInteger(maxMicros) || minMicros < 0) {
    throw new ConfigError('latency bounds must be non-negative integers', { minMicros, maxMicros });
  }
  if (maxMicros < minMicros) throw new ConfigError('maxMicros must not be below minMicros');
  return {
    name: `uniform(${String(minMicros)}us..${String(maxMicros)}us)`,
    delayMicros: (rng) => rng.nextInt(minMicros, maxMicros + 1),
  };
}

export function unlimitedLiquidity(): LiquidityModel {
  return { name: 'unlimited', maxFillQty: (ctx) => ctx.remainingQty };
}

/**
 * Caps a fill at a share of the bar's printed volume, producing partial fills for orders that are
 * large relative to the market. A strategy sized beyond the tape should find that out here rather
 * than in production.
 */
export function volumeParticipation(bps: number): LiquidityModel {
  if (!Number.isInteger(bps) || bps <= 0) {
    throw new ConfigError('participation bps must be a positive integer', { bps });
  }
  return {
    name: `participation(${String(bps)}bps)`,
    maxFillQty: (ctx) => {
      if (ctx.barVolume <= 0) return ctx.remainingQty;
      const cap = mulDiv(ctx.barVolume, bps, BPS_DIVISOR, 'floor');
      const lots = Math.floor(cap / ctx.instrument.lotSize) * ctx.instrument.lotSize;
      return asQty(Math.min(ctx.remainingQty, lots));
    },
  };
}

export interface ExecutionConfig {
  readonly slippage: SlippageModel;
  readonly commission: CommissionModel;
  readonly latency: LatencyModel;
  readonly liquidity: LiquidityModel;
  readonly intrabar: IntrabarPolicy;
}

/** `price * qty * pointValue` in money minor units. Exact via bigint (ADR-0002). */
export function notionalOf(instrument: Instrument, price: PriceInt, qty: QtyInt): MoneyInt {
  return asMoney(
    Math.abs(mulMulDiv(price, qty, instrument.pointValue, instrument.notionalDivisor, 'half-up')),
  );
}

/**
 * Money value of a price difference over a quantity, sign preserved.
 * The single conversion used for PnL, slippage attribution and mark-to-market.
 */
export function priceDeltaToMoney(instrument: Instrument, delta: number, qty: QtyInt): MoneyInt {
  return asMoney(
    mulMulDiv(delta, qty, instrument.pointValue, instrument.notionalDivisor, 'half-up'),
  );
}

/**
 * Venue presets. Each is a composition of the four models above, so any single part can be
 * swapped without inheriting the rest.
 *
 * The B3 costs come from {@link B3_TARIFFS}, transcribed from the exchange's own tables. `b3Futures`
 * assumes a day trade on the mini index with no brokerage, which is the configuration a retail day
 * trader at a zero-brokerage broker is closest to. Any other assumption is one line: build the
 * commission model yourself and pass it in.
 */
export const PRESETS = {
  /** No costs at all. Useful only for testing engine mechanics. */
  ideal: (): ExecutionConfig => ({
    slippage: noSlippage(),
    commission: noCommission(),
    latency: noLatency(),
    liquidity: unlimitedLiquidity(),
    intrabar: 'pessimistic',
  }),

  /** Binance spot: 10 bps taker, 10 bps maker, 2 bps of slippage on takers. */
  binanceSpot: (): ExecutionConfig => ({
    slippage: bpsSlippage(2),
    commission: bpsCommission({ makerBps: 10, takerBps: 10 }),
    latency: uniformLatency(20_000, 80_000),
    liquidity: volumeParticipation(1_000),
    intrabar: 'pessimistic',
  }),

  /** B3 mini futures under the `retail` cost scenario. */
  b3Futures: (): ExecutionConfig => ({
    slippage: fixedTicksSlippage(1),
    commission: b3FuturesCommission({ tariff: B3_TARIFFS.WIN, dayTrade: true }),
    latency: uniformLatency(5_000, 25_000),
    liquidity: volumeParticipation(500),
    intrabar: 'pessimistic',
  }),

  /** B3 cash equities: one tick of slippage, 3 bps of round-trip cost. */
  b3Stocks: (): ExecutionConfig => ({
    slippage: fixedTicksSlippage(1),
    commission: bpsCommission({ makerBps: 3, takerBps: 3 }),
    latency: uniformLatency(5_000, 25_000),
    liquidity: volumeParticipation(500),
    intrabar: 'pessimistic',
  }),
} as const;
