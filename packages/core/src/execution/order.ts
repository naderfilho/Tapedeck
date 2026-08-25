/**
 * Order state and the validation an order passes before it reaches the book.
 *
 * `OrderState` is deliberately mutable: it is engine-internal, one object per order, and the
 * lifetime of a run may contain hundreds of thousands of them. What a strategy sees is
 * {@link OrderSnapshot}, which is immutable and allocated only when asked for.
 */

import type { Instrument, InstrumentId } from '../instrument.ts';
import { type PriceInt, type QtyInt, asQty, isTickAligned } from '../math/fixed.ts';
import type { Timestamp } from '../time/timestamp.ts';
import { utcDayIndex } from '../time/timestamp.ts';
import type {
  NewOrder,
  OrderId,
  OrderStatus,
  OrderType,
  RejectReason,
  Side,
  TimeInForce,
} from './types.ts';

export interface OrderState {
  readonly id: OrderId;
  readonly instrumentId: InstrumentId;
  readonly side: Side;
  readonly type: OrderType;
  readonly tif: TimeInForce;
  readonly tag: string | null;
  readonly submittedTs: Timestamp;
  /** Submission order, used to break ties when several orders match in the same bar. */
  readonly submitSeq: number;
  /** UTC day of submission; a `day` order dies when the engine crosses into another one. */
  readonly submitDay: number;

  qty: QtyInt;
  limitPrice: PriceInt | null;
  stopPrice: PriceInt | null;
  status: OrderStatus;
  filledQty: QtyInt;
  /** Volume-weighted average of the fills so far. */
  avgFillPrice: PriceInt;
  /** Simulated time from which this order may match (ADR-0005). */
  readonly activeFrom: Timestamp;
  /** True once a stop or stop-limit order's trigger price has been touched. */
  triggered: boolean;
  /** Set once, so a single order never inflates the sub-bar latency statistic twice. */
  latencyCounted: boolean;
}

/** Immutable projection handed to strategies. */
export interface OrderSnapshot {
  readonly id: OrderId;
  readonly instrumentId: InstrumentId;
  readonly side: Side;
  readonly type: OrderType;
  readonly tif: TimeInForce;
  readonly tag: string | null;
  readonly qty: QtyInt;
  readonly filledQty: QtyInt;
  readonly leavesQty: QtyInt;
  readonly limitPrice: PriceInt | null;
  readonly stopPrice: PriceInt | null;
  readonly status: OrderStatus;
  readonly avgFillPrice: PriceInt;
  readonly submittedTs: Timestamp;
  readonly activeFrom: Timestamp;
  readonly triggered: boolean;
}

export function leavesQty(order: OrderState): QtyInt {
  return asQty(order.qty - order.filledQty);
}

export function snapshotOrder(order: OrderState): OrderSnapshot {
  return {
    id: order.id,
    instrumentId: order.instrumentId,
    side: order.side,
    type: order.type,
    tif: order.tif,
    tag: order.tag,
    qty: order.qty,
    filledQty: order.filledQty,
    leavesQty: leavesQty(order),
    limitPrice: order.limitPrice,
    stopPrice: order.stopPrice,
    status: order.status,
    avgFillPrice: order.avgFillPrice,
    submittedTs: order.submittedTs,
    activeFrom: order.activeFrom,
    triggered: order.triggered,
  };
}

export interface OrderRejection {
  readonly reason: RejectReason;
  readonly detail: string;
}

function needsLimit(type: OrderType): boolean {
  return type === 'limit' || type === 'stop_limit';
}

function needsStop(type: OrderType): boolean {
  return type === 'stop' || type === 'stop_limit';
}

/**
 * Pre-trade checks. Returns `null` when the order is acceptable.
 *
 * These are the checks a real venue performs before an order reaches the book. Running them in the
 * simulator means a strategy that would have been rejected in production is rejected here too,
 * rather than quietly filling at a price no exchange would have accepted.
 */
export function validateNewOrder(request: NewOrder, instrument: Instrument): OrderRejection | null {
  const { qty, type } = request;

  if (!Number.isSafeInteger(qty) || qty <= 0) {
    return {
      reason: 'invalid_quantity',
      detail: `quantity must be a positive integer, got ${String(qty)}`,
    };
  }
  if (qty % instrument.lotSize !== 0) {
    return {
      reason: 'invalid_quantity',
      detail: `quantity ${String(qty)} is not a multiple of the lot size ${String(instrument.lotSize)}`,
    };
  }

  if (needsLimit(type) && request.limitPrice === undefined) {
    return { reason: 'missing_price', detail: `${type} orders require a limit price` };
  }
  if (needsStop(type) && request.stopPrice === undefined) {
    return { reason: 'missing_price', detail: `${type} orders require a stop price` };
  }
  if (!needsLimit(type) && request.limitPrice !== undefined) {
    return { reason: 'invalid_price', detail: `${type} orders must not carry a limit price` };
  }
  if (!needsStop(type) && request.stopPrice !== undefined) {
    return { reason: 'invalid_price', detail: `${type} orders must not carry a stop price` };
  }

  for (const [label, price] of [
    ['limit', request.limitPrice],
    ['stop', request.stopPrice],
  ] as const) {
    if (price === undefined) continue;
    if (!Number.isSafeInteger(price) || price <= 0) {
      return { reason: 'invalid_price', detail: `${label} price must be a positive integer` };
    }
    if (!isTickAligned(price, instrument.tickSize)) {
      return {
        reason: 'invalid_price',
        detail: `${label} price ${String(price)} is not a multiple of the tick size ${String(instrument.tickSize)}`,
      };
    }
  }

  return null;
}

export interface CreateOrderArgs {
  readonly id: OrderId;
  readonly request: NewOrder;
  readonly submittedTs: Timestamp;
  readonly submitSeq: number;
  readonly activeFrom: Timestamp;
}

export function createOrderState(args: CreateOrderArgs): OrderState {
  const { request } = args;
  return {
    id: args.id,
    instrumentId: request.instrumentId,
    side: request.side,
    type: request.type,
    tif: request.tif ?? 'gtc',
    tag: request.tag ?? null,
    submittedTs: args.submittedTs,
    submitSeq: args.submitSeq,
    submitDay: utcDayIndex(args.submittedTs),
    qty: request.qty,
    limitPrice: request.limitPrice ?? null,
    stopPrice: request.stopPrice ?? null,
    status: 'pending',
    filledQty: asQty(0),
    avgFillPrice: 0 as PriceInt,
    activeFrom: args.activeFrom,
    triggered: false,
    latencyCounted: false,
  };
}

export function isOrderStatusLive(status: OrderStatus): boolean {
  return status === 'pending' || status === 'working' || status === 'partially_filled';
}
