/**
 * Round-trip trade extraction.
 *
 * A *trade* is the life of an exposure: it begins when a position leaves flat and ends when it
 * returns to flat. Reversals count as two trades, because that is what they are — a close and an
 * open that happen to share a fill.
 *
 * The log consumes {@link FillEffect}, which the portfolio already computed, so nothing here
 * re-derives PnL. It only tracks the things a fill does not know about on its own: the weighted
 * entry and exit prices, how long the exposure lasted, and how far it went against and in favour
 * of the position while it was open (MAE and MFE).
 */

import type { InstrumentId, InstrumentRegistry } from '../instrument.ts';
import {
  type MoneyInt,
  type PriceInt,
  type QtyInt,
  asMoney,
  asPrice,
  asQty,
  weightedAverage,
} from '../math/fixed.ts';
import type { Timestamp } from '../time/timestamp.ts';
import type { FillEffect } from './portfolio.ts';

export interface TradeRecord {
  readonly id: number;
  readonly instrumentId: InstrumentId;
  readonly symbol: string;
  readonly direction: 'long' | 'short';
  /** Quantity that was opened and then closed. */
  readonly qty: QtyInt;
  readonly entryTs: Timestamp;
  readonly exitTs: Timestamp;
  /** Volume-weighted price of the opening fills. */
  readonly entryPrice: PriceInt;
  /** Volume-weighted price of the closing fills. */
  readonly exitPrice: PriceInt;
  readonly grossPnl: MoneyInt;
  readonly commission: MoneyInt;
  readonly netPnl: MoneyInt;
  /** Bars elapsed between the opening fill and the closing fill. */
  readonly barsHeld: number;
  /** Worst unrealised PnL seen while open. Never positive. */
  readonly mae: MoneyInt;
  /** Best unrealised PnL seen while open. Never negative. */
  readonly mfe: MoneyInt;
}

interface OpenTrade {
  direction: 'long' | 'short';
  entryTs: Timestamp;
  entryQty: number;
  entryPrice: number;
  exitQty: number;
  exitPrice: number;
  grossPnl: number;
  commission: number;
  barsHeld: number;
  mae: number;
  mfe: number;
}

export class TradeLog {
  private readonly registry: InstrumentRegistry;
  private readonly open = new Map<InstrumentId, OpenTrade>();
  private readonly closed: TradeRecord[] = [];
  private nextId = 1;

  constructor(registry: InstrumentRegistry) {
    this.registry = registry;
  }

  get trades(): readonly TradeRecord[] {
    return this.closed;
  }

  /** Positions still open when the run ended, if the engine was told not to flatten. */
  get openCount(): number {
    return this.open.size;
  }

  onFill(effect: FillEffect): void {
    // A reversal is a close followed by an open. Handle it as exactly that, in that order.
    if (effect.closedQty > 0) {
      this.recordClose(effect);
    }
    if (effect.openedQty > 0) {
      this.recordOpen(effect);
    }
  }

  /**
   * Called once per bar, after the portfolio has been marked.
   * `unrealizedPnl` is the open position's current PnL, which is all MAE and MFE need.
   */
  onMark(instrumentId: InstrumentId, unrealizedPnl: MoneyInt): void {
    const trade = this.open.get(instrumentId);
    if (trade === undefined) return;
    trade.barsHeld++;
    if (unrealizedPnl < trade.mae) trade.mae = unrealizedPnl;
    if (unrealizedPnl > trade.mfe) trade.mfe = unrealizedPnl;
  }

  private recordOpen(effect: FillEffect): void {
    const existing = this.open.get(effect.instrumentId);
    const openedQty = effect.openedQty;

    if (existing === undefined) {
      this.open.set(effect.instrumentId, {
        direction: effect.qtyAfter > 0 ? 'long' : 'short',
        entryTs: effect.ts,
        entryQty: openedQty,
        entryPrice: effect.price,
        exitQty: 0,
        exitPrice: 0,
        grossPnl: 0,
        // A reversal's commission was already charged to the trade that closed; only a pure
        // opening fill contributes its commission to the new trade.
        commission: effect.closedQty > 0 ? 0 : effect.commission,
        barsHeld: 0,
        mae: 0,
        mfe: 0,
      });
      return;
    }

    existing.entryPrice = weightedAverage(
      existing.entryPrice,
      existing.entryQty,
      effect.price,
      openedQty,
    );
    existing.entryQty += openedQty;
    existing.commission += effect.commission;
  }

  private recordClose(effect: FillEffect): void {
    const trade = this.open.get(effect.instrumentId);
    if (trade === undefined) return;

    trade.exitPrice = weightedAverage(
      trade.exitPrice,
      trade.exitQty,
      effect.price,
      effect.closedQty,
    );
    trade.exitQty += effect.closedQty;
    trade.grossPnl += effect.realizedPnl;
    trade.commission += effect.commission;

    const flat = effect.qtyAfter === 0 || effect.openedQty > 0;
    if (!flat) return;

    const instrument = this.registry.byId(effect.instrumentId);
    this.closed.push({
      id: this.nextId++,
      instrumentId: effect.instrumentId,
      symbol: instrument.symbol,
      direction: trade.direction,
      qty: asQty(trade.exitQty),
      entryTs: trade.entryTs,
      exitTs: effect.ts,
      entryPrice: asPrice(trade.entryPrice),
      exitPrice: asPrice(trade.exitPrice),
      grossPnl: asMoney(trade.grossPnl),
      commission: asMoney(trade.commission),
      netPnl: asMoney(trade.grossPnl - trade.commission),
      barsHeld: trade.barsHeld,
      mae: asMoney(trade.mae),
      mfe: asMoney(trade.mfe),
    });
    this.open.delete(effect.instrumentId);
  }
}
