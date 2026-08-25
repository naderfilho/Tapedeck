import { describe, expect, it } from 'vitest';
import {
  type InstrumentId,
  ConfigError,
  INSTRUMENTS,
  InstrumentRegistry,
  NotFoundError,
  asPrice,
  asQty,
  b3Stock,
  notionalOf,
  priceDeltaToMoney,
} from '@tapedeck/core';
import { MONEY } from './helpers.ts';

function registryWith(
  ...specs: Parameters<InstrumentRegistry['register']>[0][]
): InstrumentRegistry {
  const registry = new InstrumentRegistry();
  for (const spec of specs) registry.register(spec);
  return registry;
}

describe('instrument specs', () => {
  it('resolves the B3 mini index contract from its contract sheet', () => {
    const win = registryWith(INSTRUMENTS.WIN).byId(0 as InstrumentId);
    expect(win.tickSize).toBe(5);
    expect(win.pointValue).toBe(0.2 * MONEY);
    expect(win.accounting).toBe('margin');
    expect(win.notionalDivisor).toBe(1);
  });

  it('resolves the B3 mini dollar contract', () => {
    const wdo = registryWith(INSTRUMENTS.WDO).byId(0 as InstrumentId);
    // Quoted with one decimal, so a tick of half a point is 5 in fixed point.
    expect(wdo.tickSize).toBe(5);
    expect(wdo.pointValue).toBe(10 * MONEY);
    expect(wdo.notionalDivisor).toBe(10);
  });

  it('resolves a crypto spot pair with eight decimals of quantity', () => {
    const btc = registryWith(INSTRUMENTS.BTCUSDT).byId(0 as InstrumentId);
    expect(btc.tickSize).toBe(1);
    expect(btc.lotSize).toBe(1_000);
    expect(btc.accounting).toBe('cash');
    expect(btc.notionalDivisor).toBe(10 ** 10);
  });

  it('defaults futures to margin accounting and everything else to cash', () => {
    const registry = registryWith({ ...INSTRUMENTS.WIN, accounting: undefined }, b3Stock('PETR4'));
    expect(registry.byId(0 as InstrumentId).accounting).toBe('margin');
    expect(registry.byId(1 as InstrumentId).accounting).toBe('cash');
  });

  it('rejects specs that would make later arithmetic meaningless', () => {
    expect(() => registryWith({ ...INSTRUMENTS.WIN, tickSize: '0' })).toThrow(ConfigError);
    expect(() => registryWith({ ...INSTRUMENTS.WIN, priceExp: -1 })).toThrow(ConfigError);
    expect(() => registryWith({ ...INSTRUMENTS.WIN, priceExp: 16 })).toThrow(ConfigError);
    expect(() => registryWith({ ...INSTRUMENTS.WIN, symbol: '  ' })).toThrow(ConfigError);
    expect(() => registryWith({ ...INSTRUMENTS.WIN, pointValue: '0' })).toThrow(ConfigError);
  });
});

describe('registry', () => {
  it('assigns ids in registration order, which keeps runs reproducible', () => {
    const registry = registryWith(INSTRUMENTS.WIN, INSTRUMENTS.WDO, INSTRUMENTS.BTCUSDT);
    expect(registry.all().map((i) => i.id)).toEqual([0, 1, 2]);
    expect(registry.require('B3', 'WDO').id).toBe(1);
  });

  it('refuses to register the same venue and symbol twice', () => {
    expect(() => registryWith(INSTRUMENTS.WIN, INSTRUMENTS.WIN)).toThrow(ConfigError);
  });

  it('separates instruments that share a symbol across venues', () => {
    const registry = registryWith(INSTRUMENTS.BTCUSDT, {
      ...INSTRUMENTS.BTCUSDT,
      venue: 'OTHER',
    });
    expect(registry.size).toBe(2);
    expect(registry.find('OTHER', 'BTCUSDT')?.id).toBe(1);
  });

  it('throws a typed error for an unknown lookup', () => {
    const registry = registryWith(INSTRUMENTS.WIN);
    expect(() => registry.require('B3', 'NOPE')).toThrow(NotFoundError);
    expect(() => registry.byId(9 as InstrumentId)).toThrow(NotFoundError);
    expect(registry.find('B3', 'NOPE')).toBeUndefined();
  });
});

describe('notional arithmetic', () => {
  it('applies the contract point value to a futures position', () => {
    const win = registryWith(INSTRUMENTS.WIN).byId(0 as InstrumentId);
    // Two WIN contracts at 130,000 points: 130000 * 2 * R$0.20 = R$52,000.
    expect(notionalOf(win, asPrice(130_000), asQty(2))).toBe(52_000 * MONEY);
    // A 100-point move on two contracts is R$40.
    expect(priceDeltaToMoney(win, 100, asQty(2))).toBe(40 * MONEY);
  });

  it('stays exact where the intermediate product leaves the safe-integer range', () => {
    const btc = registryWith(INSTRUMENTS.BTCUSDT).byId(0 as InstrumentId);
    // 100 BTC at 70,000: price 7e6, quantity 1e10, product 7e16 — well past 2^53.
    expect(notionalOf(btc, asPrice(7_000_000), asQty(10_000_000_000))).toBe(7_000_000 * MONEY);
  });

  it('keeps the sign of a price move', () => {
    const win = registryWith(INSTRUMENTS.WIN).byId(0 as InstrumentId);
    expect(priceDeltaToMoney(win, -100, asQty(1))).toBe(-20 * MONEY);
    expect(priceDeltaToMoney(win, 100, asQty(-1))).toBe(-20 * MONEY);
  });
});
