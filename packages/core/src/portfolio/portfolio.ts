/**
 * Positions, cash and equity.
 *
 * The ledger tracks a **cost basis in money**, not an average entry price. That distinction is the
 * whole reason this file reconciles: an average price has to be rounded to the instrument's price
 * scale, and every subsequent PnL computed from a rounded average inherits the error. A cost basis
 * is an exact amount of money, and closing part of a position releases an exact portion of it, so
 * nothing leaks. The average entry price still exists — as a derived, display-only value.
 *
 * The identity that must survive any sequence of fills, asserted by property tests:
 *
 * ```text
 * equity == initialCash + realisedPnl + unrealisedPnl - commissionPaid
 * ```
 *
 * Two accounting modes settle to it by different routes:
 *
 * - `cash` (spot, equities): a purchase spends cash and the position is worth its market value.
 * - `margin` (futures): a purchase spends only commission, and the position is worth its
 *   unrealised PnL. Notional never touches cash, which is why a futures account can hold a
 *   position many times its balance.
 *
 * Every multiplication here goes through the bigint-backed helpers in `math/fixed` (ADR-0002).
 * They run once per fill, never once per bar.
 */

import type { Instrument, InstrumentId, InstrumentRegistry } from '../instrument.ts';
import {
  type MoneyInt,
  type PriceInt,
  type QtyInt,
  asMoney,
  asPrice,
  asQty,
  mulDiv,
  mulDivDiv,
} from '../math/fixed.ts';
import { priceDeltaToMoney } from '../execution/models.ts';
import type { OrderFilledEvent } from '../events/events.ts';
import { NotFoundError } from '../util/errors.ts';
import type { Timestamp } from '../time/timestamp.ts';

export interface PositionView {
  readonly instrumentId: InstrumentId;
  /** Signed: positive is long, negative is short. */
  readonly qty: QtyInt;
  /** Money committed to the open position. Positive for a long, negative for a short. */
  readonly costBasis: MoneyInt;
  /** Derived from the cost basis for display. Zero when flat. */
  readonly avgEntry: PriceInt;
  readonly lastPrice: PriceInt;
  readonly realizedPnl: MoneyInt;
  readonly unrealizedPnl: MoneyInt;
  readonly commissionPaid: MoneyInt;
}

interface PositionState {
  readonly instrumentId: InstrumentId;
  qty: QtyInt;
  costBasis: MoneyInt;
  lastPrice: PriceInt;
  realizedPnl: MoneyInt;
  commissionPaid: MoneyInt;
}

/** What a single fill did to a position. Consumed by the trade log so it need not re-derive it. */
export interface FillEffect {
  readonly instrumentId: InstrumentId;
  readonly ts: Timestamp;
  readonly price: PriceInt;
  readonly qtyBefore: QtyInt;
  readonly qtyAfter: QtyInt;
  /** Quantity of an existing position that this fill closed. */
  readonly closedQty: QtyInt;
  /** Quantity of new exposure this fill opened. */
  readonly openedQty: QtyInt;
  /** Realised PnL produced by this fill alone, gross of commission. */
  readonly realizedPnl: MoneyInt;
  readonly commission: MoneyInt;
}

function sign(value: number): number {
  return value === 0 ? 0 : value < 0 ? -1 : 1;
}

export class Portfolio {
  private readonly registry: InstrumentRegistry;
  private readonly positions: PositionState[] = [];
  readonly initialCash: MoneyInt;
  private cashBalance: MoneyInt;

  constructor(registry: InstrumentRegistry, initialCash: MoneyInt) {
    this.registry = registry;
    this.initialCash = initialCash;
    this.cashBalance = initialCash;
    for (const instrument of registry.all()) {
      this.positions.push({
        instrumentId: instrument.id,
        qty: asQty(0),
        costBasis: asMoney(0),
        lastPrice: asPrice(0),
        realizedPnl: asMoney(0),
        commissionPaid: asMoney(0),
      });
    }
  }

  get cash(): MoneyInt {
    return this.cashBalance;
  }

  /**
   * Applies a fill to the ledger and reports what it did.
   *
   * Three cases: adding to a position (the cost basis grows by the notional), reducing one (an
   * exact proportion of the cost basis is released and the difference is realised), and reversing
   * through zero (the old position is fully released, then the remainder opens at the fill price).
   * The third is the classic backtester bug, so it is exercised directly by property tests.
   */
  applyFill(fill: OrderFilledEvent): FillEffect {
    const instrument = this.registry.byId(fill.instrumentId);
    const position = this.positionState(fill.instrumentId);
    const filledQty: number = fill.qty;
    const signedQty = fill.side === 'buy' ? filledQty : -filledQty;
    const qtyBefore = position.qty;

    let realized = 0;
    let closedQty = 0;
    let openedQty = 0;

    if (qtyBefore === 0 || sign(qtyBefore) === sign(signedQty)) {
      position.costBasis = asMoney(
        position.costBasis + priceDeltaToMoney(instrument, fill.price, asQty(signedQty)),
      );
      openedQty = filledQty;
    } else {
      const positionSign = sign(qtyBefore);
      closedQty = Math.min(Math.abs(qtyBefore), filledQty);
      openedQty = filledQty - closedQty;

      // Cash generated by closing: positive when a long is sold, negative when a short is bought.
      const closeFlow = priceDeltaToMoney(instrument, fill.price, asQty(positionSign * closedQty));
      // The exact slice of the cost basis this close consumes. Subtracting it keeps the remaining
      // basis exact: no rounding residue accumulates across partial closes.
      const released = mulDiv(position.costBasis, closedQty, Math.abs(qtyBefore), 'half-even');
      realized = closeFlow - released;
      position.costBasis = asMoney(position.costBasis - released);

      if (openedQty > 0) {
        position.costBasis = asMoney(
          position.costBasis +
            priceDeltaToMoney(instrument, fill.price, asQty(sign(signedQty) * openedQty)),
        );
      }
    }

    const qtyAfter = asQty(qtyBefore + signedQty);
    position.qty = qtyAfter;
    if (qtyAfter === 0) position.costBasis = asMoney(0);

    position.realizedPnl = asMoney(position.realizedPnl + realized);
    position.commissionPaid = asMoney(position.commissionPaid + fill.commission);
    position.lastPrice = fill.price;

    this.cashBalance = asMoney(this.cashBalance - fill.commission);
    if (instrument.accounting === 'cash') {
      // A purchase spends money and a sale returns it: the mirror image of the signed notional.
      this.cashBalance = asMoney(
        this.cashBalance + priceDeltaToMoney(instrument, fill.price, asQty(-signedQty)),
      );
    } else {
      this.cashBalance = asMoney(this.cashBalance + realized);
    }

    return {
      instrumentId: fill.instrumentId,
      ts: fill.ts,
      price: fill.price,
      qtyBefore,
      qtyAfter,
      closedQty: asQty(closedQty),
      openedQty: asQty(openedQty),
      realizedPnl: asMoney(realized),
      commission: fill.commission,
    };
  }

  /**
   * Rebuilds the ledger from a snapshot, for a paper session coming back after a crash.
   *
   * The cost basis is restored, never the average entry price. Reconstructing the basis from a
   * rounded average is exactly the leak this class exists to avoid, and a restart is the worst
   * place to introduce it — the error would then compound across every later fill (ADR-0002).
   *
   * `unrealizedPnl` and `avgEntry` in the view are derived and therefore ignored here: they are
   * recomputed from the basis and the mark.
   */
  restore(cash: MoneyInt, positions: readonly PositionView[]): void {
    this.cashBalance = cash;
    for (const position of this.positions) {
      position.qty = asQty(0);
      position.costBasis = asMoney(0);
      position.lastPrice = asPrice(0);
      position.realizedPnl = asMoney(0);
      position.commissionPaid = asMoney(0);
    }
    for (const view of positions) {
      const state = this.positionState(view.instrumentId);
      state.qty = view.qty;
      state.costBasis = view.costBasis;
      state.lastPrice = view.lastPrice;
      state.realizedPnl = view.realizedPnl;
      state.commissionPaid = view.commissionPaid;
    }
  }

  /** Records the latest traded price for an instrument. Called once per bar. */
  mark(instrumentId: InstrumentId, price: PriceInt): void {
    this.positionState(instrumentId).lastPrice = price;
  }

  /** What the open position would be worth if closed at the last price. */
  marketValueOf(instrumentId: InstrumentId): MoneyInt {
    const position = this.positionState(instrumentId);
    if (position.qty === 0 || position.lastPrice === 0) return asMoney(0);
    const instrument = this.registry.byId(instrumentId);
    return priceDeltaToMoney(instrument, position.lastPrice, position.qty);
  }

  unrealizedPnlOf(instrumentId: InstrumentId): MoneyInt {
    const position = this.positionState(instrumentId);
    if (position.qty === 0 || position.lastPrice === 0) return asMoney(0);
    return asMoney(this.marketValueOf(instrumentId) - position.costBasis);
  }

  /** Contribution of an open position to equity, which depends on the accounting mode. */
  private equityContribution(instrument: Instrument): MoneyInt {
    return instrument.accounting === 'margin'
      ? this.unrealizedPnlOf(instrument.id)
      : this.marketValueOf(instrument.id);
  }

  equity(): MoneyInt {
    let total: number = this.cashBalance;
    for (const instrument of this.registry.all()) {
      total += this.equityContribution(instrument);
    }
    return asMoney(total);
  }

  unrealizedPnl(): MoneyInt {
    let total = 0;
    for (const instrument of this.registry.all()) {
      total += this.unrealizedPnlOf(instrument.id);
    }
    return asMoney(total);
  }

  realizedPnl(): MoneyInt {
    let total = 0;
    for (const position of this.positions) total += position.realizedPnl;
    return asMoney(total);
  }

  commissionPaid(): MoneyInt {
    let total = 0;
    for (const position of this.positions) total += position.commissionPaid;
    return asMoney(total);
  }

  /** Margin blocked by open futures positions. Zero for cash instruments. */
  marginUsed(): MoneyInt {
    let total = 0;
    for (const instrument of this.registry.all()) {
      if (instrument.accounting !== 'margin' || instrument.initialMargin === 0) continue;
      const position = this.positionState(instrument.id);
      if (position.qty === 0) continue;
      total += mulDiv(
        instrument.initialMargin,
        Math.abs(position.qty),
        10 ** instrument.qtyExp,
        'half-up',
      );
    }
    return asMoney(total);
  }

  /** Volume-weighted entry price, reconstructed from the cost basis. Display only. */
  avgEntryOf(instrumentId: InstrumentId): PriceInt {
    const position = this.positionState(instrumentId);
    if (position.qty === 0) return asPrice(0);
    const instrument = this.registry.byId(instrumentId);
    return asPrice(
      mulDivDiv(
        Math.abs(position.costBasis),
        instrument.notionalDivisor,
        instrument.pointValue,
        Math.abs(position.qty),
        'half-even',
      ),
    );
  }

  positionOf(instrumentId: InstrumentId): PositionView {
    const position = this.positionState(instrumentId);
    return {
      instrumentId,
      qty: position.qty,
      costBasis: position.costBasis,
      avgEntry: this.avgEntryOf(instrumentId),
      lastPrice: position.lastPrice,
      realizedPnl: position.realizedPnl,
      unrealizedPnl: this.unrealizedPnlOf(instrumentId),
      commissionPaid: position.commissionPaid,
    };
  }

  /** Instruments currently holding a non-zero position. */
  openPositions(): readonly PositionView[] {
    const out: PositionView[] = [];
    for (const position of this.positions) {
      if (position.qty !== 0) out.push(this.positionOf(position.instrumentId));
    }
    return out;
  }

  private positionState(instrumentId: InstrumentId): PositionState {
    const position = this.positions[instrumentId];
    if (position === undefined) {
      throw new NotFoundError(`no position slot for instrument ${String(instrumentId)}`, {
        instrumentId,
      });
    }
    return position;
  }
}
