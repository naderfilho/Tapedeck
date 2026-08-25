/**
 * The event contracts.
 *
 * Every event carries `(ts, seq)`. Together they form a total order: no two events in a run
 * compare equal, so "what happened first" always has exactly one answer (ADR-0006).
 *
 * Market-data events are the exception to the "one object per event" rule. A backtest produces
 * millions of them, and allocating an object per bar costs more than everything else the engine
 * does put together, so a bar is delivered as a reused view over columnar storage — an object that
 * satisfies {@link BarEvent} but is refilled rather than reallocated (ADR-0004). Order lifecycle
 * events happen thousands of times, not millions, and are ordinary immutable objects.
 */

import type { InstrumentId } from '../instrument.ts';
import type { MoneyInt, PriceInt, QtyInt } from '../math/fixed.ts';
import type { Timestamp } from '../time/timestamp.ts';
import type {
  FillId,
  Liquidity,
  OrderId,
  OrderStatus,
  OrderType,
  RejectReason,
  Side,
  TimeInForce,
} from '../execution/types.ts';

export const EventKind = {
  Bar: 0,
  Tick: 1,
  Signal: 2,
  OrderAccepted: 3,
  OrderRejected: 4,
  OrderFilled: 5,
  OrderCancelled: 6,
  PortfolioUpdate: 7,
  OrderAmended: 8,
} as const;

export type EventKind = (typeof EventKind)[keyof typeof EventKind];

export interface EventBase {
  readonly kind: EventKind;
  /** Simulated (or wall) time at which the event became true. */
  readonly ts: Timestamp;
  /** Monotonic within a run. Breaks ties between events sharing a timestamp. */
  readonly seq: number;
}

/**
 * A closed candle. `[openTs, closeTs)` is half-open: the bar covers the interval up to but not
 * including its close, and the event exists at `closeTs` — the first instant the information is
 * knowable. Nothing in the engine may act on a bar before that instant (ADR-0005).
 */
export interface BarEvent extends EventBase {
  readonly kind: typeof EventKind.Bar;
  readonly instrumentId: InstrumentId;
  readonly openTs: Timestamp;
  readonly closeTs: Timestamp;
  readonly open: PriceInt;
  readonly high: PriceInt;
  readonly low: PriceInt;
  readonly close: PriceInt;
  readonly volume: QtyInt;
  /** Zero-based position of this bar within the run. Useful in logs and assertions. */
  readonly index: number;
}

/** A single print from the time-and-sales tape. */
export interface TickEvent extends EventBase {
  readonly kind: typeof EventKind.Tick;
  readonly instrumentId: InstrumentId;
  readonly price: PriceInt;
  readonly size: QtyInt;
  /** Which side crossed the spread, when the venue reports it. */
  readonly aggressor: Side | null;
  readonly index: number;
}

export type MarketEvent = BarEvent | TickEvent;

/**
 * A strategy's stated intent, recorded for attribution.
 *
 * Optional by design: a strategy may go straight from `onBar` to `submit`. Emitting signals lets
 * the report line up intent against execution and answer "how much of the edge did slippage eat".
 */
export interface SignalEvent extends EventBase {
  readonly kind: typeof EventKind.Signal;
  readonly instrumentId: InstrumentId;
  readonly direction: 'long' | 'short' | 'flat';
  /** Strategy-defined conviction. Not interpreted by the engine. */
  readonly strength: number;
  readonly tag: string | null;
}

export interface OrderAcceptedEvent extends EventBase {
  readonly kind: typeof EventKind.OrderAccepted;
  readonly orderId: OrderId;
  readonly instrumentId: InstrumentId;
  readonly side: Side;
  readonly type: OrderType;
  readonly qty: QtyInt;
  readonly limitPrice: PriceInt | null;
  readonly stopPrice: PriceInt | null;
  readonly tif: TimeInForce;
  readonly tag: string | null;
  /** Simulated time from which the order can match. `acceptedTs + latency` (ADR-0005). */
  readonly activeFrom: Timestamp;
}

export interface OrderRejectedEvent extends EventBase {
  readonly kind: typeof EventKind.OrderRejected;
  readonly orderId: OrderId;
  readonly reason: RejectReason;
  readonly detail: string;
  readonly tag: string | null;
}

export interface OrderFilledEvent extends EventBase {
  readonly kind: typeof EventKind.OrderFilled;
  readonly orderId: OrderId;
  readonly fillId: FillId;
  readonly instrumentId: InstrumentId;
  readonly side: Side;
  /** Price actually paid, slippage included. */
  readonly price: PriceInt;
  /** Quantity of this fill alone, not of the order. */
  readonly qty: QtyInt;
  /** Quantity still outstanding on the order after this fill. */
  readonly leavesQty: QtyInt;
  readonly commission: MoneyInt;
  /**
   * Money given up to slippage on this fill: `(price - referencePrice) * qty * pointValue`,
   * signed so that a positive number always means the fill was worse than the reference.
   */
  readonly slippage: MoneyInt;
  readonly liquidity: Liquidity;
  readonly tag: string | null;
}

export interface OrderCancelledEvent extends EventBase {
  readonly kind: typeof EventKind.OrderCancelled;
  readonly orderId: OrderId;
  readonly reason: 'requested' | 'expired' | 'time_in_force' | 'run_ended' | 'oco';
  readonly leavesQty: QtyInt;
  readonly tag: string | null;
}

export interface PortfolioUpdateEvent extends EventBase {
  readonly kind: typeof EventKind.PortfolioUpdate;
  readonly cash: MoneyInt;
  readonly equity: MoneyInt;
  readonly realizedPnl: MoneyInt;
  readonly unrealizedPnl: MoneyInt;
  readonly marginUsed: MoneyInt;
}

/**
 * An order changed in place, keeping its id and its queue position.
 *
 * It exists for the record rather than for the strategy: a report that shows a limit filling at a
 * price the order was never submitted at, with nothing in between to explain it, is a report that
 * looks wrong. Both the old and the new values are carried so the change is legible without
 * replaying the run.
 */
export interface OrderAmendedEvent extends EventBase {
  readonly kind: typeof EventKind.OrderAmended;
  readonly orderId: OrderId;
  readonly instrumentId: InstrumentId;
  readonly qty: QtyInt;
  readonly previousQty: QtyInt;
  readonly limitPrice: PriceInt | null;
  readonly previousLimitPrice: PriceInt | null;
  readonly stopPrice: PriceInt | null;
  readonly previousStopPrice: PriceInt | null;
  /** Why the engine changed it: a strategy asked, or an OCO sibling filled. */
  readonly reason: 'requested' | 'oco';
  readonly tag: string | null;
}

export type OrderEvent =
  | OrderAcceptedEvent
  | OrderRejectedEvent
  | OrderFilledEvent
  | OrderCancelledEvent
  | OrderAmendedEvent;

export type TapedeckEvent = MarketEvent | SignalEvent | OrderEvent | PortfolioUpdateEvent;

/** Terminal order status, for readers that only care whether an order is done. */
export function isTerminalStatus(status: OrderStatus): boolean {
  return status === 'filled' || status === 'cancelled' || status === 'rejected';
}
