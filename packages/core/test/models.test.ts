import { describe, expect, it } from 'vitest';
import {
  type Instrument,
  type InstrumentId,
  type Liquidity,
  type Side,
  type SlippageModel,
  ConfigError,
  INSTRUMENTS,
  InstrumentRegistry,
  PRESETS,
  asPrice,
  asQty,
  B3_TARIFFS,
  b3FuturesCommission,
  bpsCommission,
  bpsSlippage,
  createRng,
  fixedLatency,
  fixedTicksSlippage,
  noCommission,
  noLatency,
  noSlippage,
  notionalOf,
  perUnitCommission,
  rangeFractionSlippage,
  uniformLatency,
  unlimitedLiquidity,
  volumeParticipation,
  withJitter,
} from '@tapedeck/core';
import { MONEY, TEST_FUTURE } from './helpers.ts';

function instrumentOf(spec: Parameters<InstrumentRegistry['register']>[0]): Instrument {
  const registry = new InstrumentRegistry();
  registry.register(spec);
  return registry.byId(0 as InstrumentId);
}

const FUTURE = instrumentOf(TEST_FUTURE);
const WIN = instrumentOf(INSTRUMENTS.WIN);

function slip(
  model: SlippageModel,
  options: {
    side: Side;
    price: number;
    liquidity?: Liquidity;
    barRange?: number;
    instrument?: Instrument;
  },
): number {
  return model.apply({
    instrument: options.instrument ?? FUTURE,
    side: options.side,
    type: 'market',
    qty: asQty(1),
    referencePrice: asPrice(options.price),
    liquidity: options.liquidity ?? 'taker',
    barRange: asPrice(options.barRange ?? 0),
    rng: createRng(1),
  });
}

describe('slippage models', () => {
  it('leaves the price alone when configured to', () => {
    expect(slip(noSlippage(), { side: 'buy', price: 100 })).toBe(100);
  });

  it('always moves the price against the taker', () => {
    const model = fixedTicksSlippage(2);
    expect(slip(model, { side: 'buy', price: 100 })).toBe(102);
    expect(slip(model, { side: 'sell', price: 100 })).toBe(98);
  });

  it('never charges a maker', () => {
    for (const model of [fixedTicksSlippage(2), bpsSlippage(50), rangeFractionSlippage(5_000)]) {
      expect(slip(model, { side: 'buy', price: 100, liquidity: 'maker', barRange: 10 })).toBe(100);
    }
  });

  it('scales with the price in bps mode and snaps to the tick', () => {
    // 50 bps of 130,000 index points is 650, and the WIN tick is 5 points.
    expect(slip(bpsSlippage(50), { side: 'buy', price: 130_000, instrument: WIN })).toBe(130_650);
    expect(slip(bpsSlippage(50), { side: 'sell', price: 130_000, instrument: WIN })).toBe(129_350);
  });

  it('scales with the bar range, so a violent bar costs more than a quiet one', () => {
    const model = rangeFractionSlippage(2_500);
    expect(slip(model, { side: 'buy', price: 100, barRange: 20 })).toBe(105);
    expect(slip(model, { side: 'buy', price: 100, barRange: 0 })).toBe(100);
  });

  it('adds a bounded, reproducible jitter on top of another model', () => {
    const model = withJitter(fixedTicksSlippage(1), 3);
    const draws = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const rng = createRng(i);
      draws.add(
        model.apply({
          instrument: FUTURE,
          side: 'buy',
          type: 'market',
          qty: asQty(1),
          referencePrice: asPrice(100),
          liquidity: 'taker',
          barRange: asPrice(0),
          rng,
        }),
      );
    }
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(101);
    expect(Math.max(...draws)).toBeLessThanOrEqual(104);
    expect(draws.size).toBeGreaterThan(1);
    expect(withJitter(fixedTicksSlippage(1), 0).name).toContain('jitter(0)');
  });

  it('rejects nonsensical parameters at construction, not at the first fill', () => {
    expect(() => fixedTicksSlippage(-1)).toThrow(ConfigError);
    expect(() => bpsSlippage(1.5)).toThrow(ConfigError);
    expect(() => rangeFractionSlippage(-2)).toThrow(ConfigError);
    expect(() => withJitter(noSlippage(), -1)).toThrow(ConfigError);
  });
});

describe('commission models', () => {
  const context = (qty: number, price: number, liquidity: Liquidity = 'taker') => ({
    instrument: FUTURE,
    side: 'buy' as Side,
    qty: asQty(qty),
    price: asPrice(price),
    notional: notionalOf(FUTURE, asPrice(price), asQty(qty)),
    liquidity,
  });

  it('charges nothing when configured to', () => {
    expect(noCommission().charge(context(10, 100))).toBe(0);
  });

  it('charges a flat amount per unit of quantity', () => {
    expect(perUnitCommission('0.50').charge(context(4, 100))).toBe(2 * MONEY);
  });

  it('charges a share of notional and honours a minimum', () => {
    const model = bpsCommission({ makerBps: 2, takerBps: 10, minimum: '5' });
    // 10 units at 1000 is 10,000 of notional; 10 bps is 10, above the minimum.
    expect(model.charge(context(10, 1_000))).toBe(10 * MONEY);
    // The same trade as a maker is 2 bps, which the 5.00 floor overrides.
    expect(model.charge(context(10, 1_000, 'maker'))).toBe(5 * MONEY);
  });

  it('charges the exchange tariff plus brokerage, per contract', () => {
    // WIN is published at R$0.30 per contract; add fifty centavos of brokerage and two contracts
    // cost 2 x 0.80.
    const model = b3FuturesCommission({ tariff: B3_TARIFFS.WIN, brokerage: '0.50' });
    expect(model.charge(context(2, 130_000))).toBe(1.6 * MONEY);
    expect(model.name).toContain('WIN 0.30BRL');
  });

  it('applies the day-trade reduction to the exchange half only', () => {
    // 35% off R$0.30 is R$0.195; brokerage is the broker's business and is not discounted.
    const model = b3FuturesCommission({
      tariff: B3_TARIFFS.WIN,
      dayTrade: true,
      brokerage: '0.50',
    });
    expect(model.charge(context(1, 130_000))).toBe(0.695 * MONEY);
    expect(model.name).toContain('dt');
  });

  it('refuses to invent an exchange rate for a dollar-denominated tariff', () => {
    // WDO is published at US$0.12 per contract, so its cost in reais is not knowable without a
    // rate. Guessing one would put an invented number into every fill.
    expect(() => b3FuturesCommission({ tariff: B3_TARIFFS.WDO })).toThrow(/priced in USD/);
    const model = b3FuturesCommission({ tariff: B3_TARIFFS.WDO, usdBrl: '5.40' });
    // 0.12 x 5.40 = 0.648
    expect(model.charge(context(1, 54_000))).toBe(0.648 * MONEY);
    expect(model.name).toContain('@5.40');
  });

  it('refuses a rate for a tariff that is already in reais', () => {
    expect(() => b3FuturesCommission({ tariff: B3_TARIFFS.WIN, usdBrl: '5.40' })).toThrow(
      /does not apply/,
    );
  });

  it('carries the source and the date it was read, so a stale figure is visible', () => {
    for (const tariff of Object.values(B3_TARIFFS)) {
      expect(tariff.source).toContain('b3.com.br');
      expect(tariff.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('rejects negative costs', () => {
    expect(() => perUnitCommission('-1')).toThrow(ConfigError);
    expect(() => bpsCommission({ makerBps: -1, takerBps: 1 })).toThrow(ConfigError);
  });
});

describe('latency models', () => {
  it('reports zero when disabled', () => {
    expect(noLatency().delayMicros(createRng(1))).toBe(0);
  });

  it('is constant when fixed', () => {
    const model = fixedLatency(50_000);
    expect(model.delayMicros(createRng(1))).toBe(50_000);
    expect(model.name).toBe('fixed(50000us)');
  });

  it('stays inside its bounds when uniform', () => {
    const model = uniformLatency(10, 20);
    const rng = createRng(3);
    for (let i = 0; i < 100; i++) {
      const delay = model.delayMicros(rng);
      expect(delay).toBeGreaterThanOrEqual(10);
      expect(delay).toBeLessThanOrEqual(20);
    }
  });

  it('rejects impossible bounds', () => {
    expect(() => fixedLatency(-1)).toThrow(ConfigError);
    expect(() => uniformLatency(20, 10)).toThrow(ConfigError);
    expect(() => uniformLatency(-1, 10)).toThrow(ConfigError);
  });
});

describe('liquidity models', () => {
  it('lets an order take everything it wants when unlimited', () => {
    const model = unlimitedLiquidity();
    expect(
      model.maxFillQty({ instrument: FUTURE, remainingQty: asQty(50), barVolume: asQty(1) }),
    ).toBe(50);
  });

  it('caps at a share of volume and rounds down to the lot size', () => {
    const model = volumeParticipation(1_000);
    expect(
      model.maxFillQty({ instrument: FUTURE, remainingQty: asQty(50), barVolume: asQty(37) }),
    ).toBe(3);
  });

  it('does not cap when the bar reports no volume', () => {
    const model = volumeParticipation(1_000);
    expect(
      model.maxFillQty({ instrument: FUTURE, remainingQty: asQty(50), barVolume: asQty(0) }),
    ).toBe(50);
  });

  it('rejects a non-positive participation', () => {
    expect(() => volumeParticipation(0)).toThrow(ConfigError);
  });
});

describe('venue presets', () => {
  it('composes four named models each, and names them in the run config', () => {
    for (const preset of [
      PRESETS.ideal,
      PRESETS.binanceSpot,
      PRESETS.b3Futures,
      PRESETS.b3Stocks,
    ]) {
      const config = preset();
      expect(config.slippage.name).toBeTruthy();
      expect(config.commission.name).toBeTruthy();
      expect(config.latency.name).toBeTruthy();
      expect(config.liquidity.name).toBeTruthy();
      expect(config.intrabar).toBe('pessimistic');
    }
  });

  it('charges nothing at all in the ideal preset, which is why it is only for testing', () => {
    const ideal = PRESETS.ideal();
    expect(slip(ideal.slippage, { side: 'buy', price: 100 })).toBe(100);
    expect(ideal.latency.delayMicros(createRng(1))).toBe(0);
  });
});
