import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  type InstrumentId,
  type InstrumentSpec,
  type MoneyInt,
  type OrderFilledEvent,
  type Side,
  EventKind,
  InstrumentRegistry,
  Portfolio,
  asMoney,
  asPrice,
  asQty,
  parseFixed,
} from '@tapedeck/core';
import { MONEY, TEST_FUTURE, TEST_SPOT, money } from './helpers.ts';

let fillSeq = 0;

function makeFill(
  side: Side,
  qty: number,
  price: number,
  commission = 0,
  instrumentId = 0,
): OrderFilledEvent {
  fillSeq += 1;
  return {
    kind: EventKind.OrderFilled,
    ts: fillSeq as never,
    seq: fillSeq,
    orderId: fillSeq as never,
    fillId: fillSeq as never,
    instrumentId: instrumentId as InstrumentId,
    side,
    price: asPrice(price),
    qty: asQty(qty),
    leavesQty: asQty(0),
    commission: asMoney(commission),
    slippage: asMoney(0),
    liquidity: 'taker',
    tag: null,
  };
}

function portfolioOf(spec: InstrumentSpec, cash = '100000'): Portfolio {
  const registry = new InstrumentRegistry();
  registry.register(spec);
  return new Portfolio(registry, asMoney(parseFixed(cash, 8)));
}

const ZERO = 0 as InstrumentId;

describe('position accounting', () => {
  it('opens, marks and closes a long', () => {
    const portfolio = portfolioOf(TEST_FUTURE);
    portfolio.applyFill(makeFill('buy', 2, 100));

    expect(portfolio.positionOf(ZERO).qty).toBe(2);
    expect(portfolio.positionOf(ZERO).avgEntry).toBe(100);

    portfolio.mark(ZERO, asPrice(110));
    expect(portfolio.unrealizedPnl()).toBe(money(20));
    expect(portfolio.equity()).toBe(money(100_020));

    portfolio.applyFill(makeFill('sell', 2, 110));
    expect(portfolio.positionOf(ZERO).qty).toBe(0);
    expect(portfolio.realizedPnl()).toBe(money(20));
    expect(portfolio.unrealizedPnl()).toBe(0);
    expect(portfolio.equity()).toBe(money(100_020));
  });

  it('opens, marks and closes a short', () => {
    const portfolio = portfolioOf(TEST_FUTURE);
    portfolio.applyFill(makeFill('sell', 1, 100));
    portfolio.mark(ZERO, asPrice(90));

    expect(portfolio.positionOf(ZERO).qty).toBe(-1);
    expect(portfolio.unrealizedPnl()).toBe(money(10));

    portfolio.applyFill(makeFill('buy', 1, 90));
    expect(portfolio.realizedPnl()).toBe(money(10));
    expect(portfolio.equity()).toBe(money(100_010));
  });

  it('re-averages the entry when adding to a position', () => {
    const portfolio = portfolioOf(TEST_FUTURE);
    portfolio.applyFill(makeFill('buy', 1, 100));
    portfolio.applyFill(makeFill('buy', 3, 200));
    expect(portfolio.positionOf(ZERO).avgEntry).toBe(175);
    expect(portfolio.realizedPnl()).toBe(0);
  });

  it('realises the old position and re-opens at the fill price on a reversal', () => {
    const portfolio = portfolioOf(TEST_FUTURE);
    portfolio.applyFill(makeFill('buy', 2, 100));
    const effect = portfolio.applyFill(makeFill('sell', 5, 120));

    expect(effect.closedQty).toBe(2);
    expect(effect.openedQty).toBe(3);
    expect(effect.realizedPnl).toBe(money(40));
    expect(portfolio.positionOf(ZERO).qty).toBe(-3);
    expect(portfolio.positionOf(ZERO).avgEntry).toBe(120);
  });

  it('charges commission to cash whatever the accounting mode', () => {
    const futures = portfolioOf(TEST_FUTURE);
    futures.applyFill(makeFill('buy', 1, 100, money(2)));
    expect(futures.cash).toBe(money(99_998));
    expect(futures.commissionPaid()).toBe(money(2));
  });
});

describe('cash versus margin accounting', () => {
  it('spends cash on a spot purchase and does not on a futures purchase', () => {
    const spot = portfolioOf(TEST_SPOT);
    spot.applyFill(makeFill('buy', 3, 100));
    expect(spot.cash).toBe(money(100_000 - 300));
    spot.mark(ZERO, asPrice(100));
    expect(spot.equity()).toBe(money(100_000));

    const futures = portfolioOf(TEST_FUTURE);
    futures.applyFill(makeFill('buy', 3, 100));
    expect(futures.cash).toBe(money(100_000));
  });

  it('blocks initial margin per contract on futures only', () => {
    const futures = portfolioOf(TEST_FUTURE);
    futures.applyFill(makeFill('buy', 4, 100));
    expect(futures.marginUsed()).toBe(money(400));

    const spot = portfolioOf(TEST_SPOT);
    spot.applyFill(makeFill('buy', 4, 100));
    expect(spot.marginUsed()).toBe(0);
  });
});

/**
 * The identity that has to survive any sequence of fills. If it ever fails, the reported PnL and
 * the reported equity are telling two different stories, which is the single failure mode that
 * would make every other number in a report worthless.
 */
function expectEquityIdentity(portfolio: Portfolio, initialCash: MoneyInt): void {
  const expected =
    initialCash + portfolio.realizedPnl() + portfolio.unrealizedPnl() - portfolio.commissionPaid();
  expect(portfolio.equity()).toBe(expected);
}

describe('equity identity (property)', () => {
  const fillArb = fc.record({
    side: fc.constantFrom<Side>('buy', 'sell'),
    qty: fc.integer({ min: 1, max: 20 }),
    price: fc.integer({ min: 50, max: 500 }),
    commission: fc.integer({ min: 0, max: 5 }),
  });

  for (const spec of [TEST_FUTURE, TEST_SPOT]) {
    it(`holds for ${spec.accounting ?? 'default'} accounting on any fill sequence`, () => {
      fc.assert(
        fc.property(
          fc.array(fillArb, { minLength: 1, maxLength: 40 }),
          fc.integer({ min: 50, max: 500 }),
          (fills, markPrice) => {
            const initialCash = asMoney(money(100_000));
            const registry = new InstrumentRegistry();
            registry.register(spec);
            const portfolio = new Portfolio(registry, initialCash);

            for (const f of fills) {
              portfolio.applyFill(makeFill(f.side, f.qty, f.price, f.commission * MONEY));
            }
            portfolio.mark(ZERO, asPrice(markPrice));
            expectEquityIdentity(portfolio, initialCash);
          },
        ),
        { numRuns: 300 },
      );
    });
  }

  it('leaves no unrealised PnL once a position is flat', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 10 }),
        fc.array(fc.integer({ min: 50, max: 500 }), { minLength: 1, maxLength: 10 }),
        (quantities, prices) => {
          const portfolio = portfolioOf(TEST_FUTURE);
          let openQty = 0;
          quantities.forEach((qty, i) => {
            const price = prices[i % prices.length] ?? 100;
            portfolio.applyFill(makeFill('buy', qty, price));
            openQty += qty;
          });
          portfolio.applyFill(makeFill('sell', openQty, 250));

          expect(portfolio.positionOf(ZERO).qty).toBe(0);
          expect(portfolio.positionOf(ZERO).avgEntry).toBe(0);
          expect(portfolio.unrealizedPnl()).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
