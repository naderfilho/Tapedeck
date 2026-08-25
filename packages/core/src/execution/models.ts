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

export interface B3FuturesCostOptions {
  /** Exchange fee per contract, decimal string in BRL. */
  readonly emoluments: string;
  /** Registration fee per contract. */
  readonly registration: string;
  /** Broker commission per contract. */
  readonly brokerage: string;
}

/**
 * B3 futures costs, kept as three separate line items.
 *
 * Splitting them costs nothing and means each can be updated from its own source: the exchange
 * publishes emoluments and registration, and brokerage is whatever your broker charges — for mini
 * contracts on a day trade, several Brazilian brokers charge nothing at all.
 *
 * The figures in {@link B3_COST_SCENARIOS} are **scenarios, not quotes**. Nobody should read a
 * number out of this file and believe it: B3's fees vary by contract, by investor category and by
 * volume band, and they change. What the engine guarantees instead is that whatever you charged is
 * printed with the result — the model's `name` carries the three components into every report —
 * and that `breakEvenCostPerUnit` in `@tapedeck/report` tells you the only figure that does not
 * depend on knowing the real one: the cost per contract at which this strategy stops making money.
 */
export function b3FuturesCommission(options: B3FuturesCostOptions): CommissionModel {
  const perContract =
    parseFixed(options.emoluments, MONEY_EXP) +
    parseFixed(options.registration, MONEY_EXP) +
    parseFixed(options.brokerage, MONEY_EXP);
  if (perContract < 0) throw new ConfigError('B3 cost components must not be negative');
  return {
    name: `b3-futures(${options.emoluments}+${options.registration}+${options.brokerage})`,
    charge: (ctx) => asMoney(mulDiv(perContract, ctx.qty, 10 ** ctx.instrument.qtyExp, 'half-up')),
  };
}

/**
 * Cost scenarios for B3 mini futures, per contract per side, in BRL.
 *
 * Three shapes rather than one number, because the honest answer to "what does it cost" is "it
 * depends on your broker, and here is how much that matters". Run the same strategy under two of
 * these and the difference between the results *is* the answer to how cost-sensitive it is.
 *
 * None of these is a quote. `zeroBrokerage` is the configuration a day trader on minis at a
 * zero-brokerage broker is closest to; `retail` adds a per-contract charge of the order several
 * brokers publish; `heavy` exists to be obviously pessimistic, which is the most useful scenario a
 * strategy can survive.
 */
export const B3_COST_SCENARIOS = {
  /** Exchange charges only. The lower bound anyone actually trades at. */
  zeroBrokerage: { emoluments: '0.25', registration: '0.10', brokerage: '0' },
  /** Exchange charges plus a per-contract brokerage. */
  retail: { emoluments: '0.25', registration: '0.10', brokerage: '0.50' },
  /** Deliberately punitive. A strategy that survives this one is not a cost illusion. */
  heavy: { emoluments: '0.25', registration: '0.10', brokerage: '2.00' },
} as const satisfies Readonly<Record<string, B3FuturesCostOptions>>;

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
 * The B3 costs come from {@link B3_COST_SCENARIOS}, which are scenarios rather than quotes. A
 * currency amount produced under one of them is an answer to "what would this have made at these
 * costs", never to "what would this have made". `b3Futures` uses the retail scenario because a
 * middle assumption is the least misleading default; the sweep in the B3 example runs all three.
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
    commission: b3FuturesCommission(B3_COST_SCENARIOS.retail),
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
