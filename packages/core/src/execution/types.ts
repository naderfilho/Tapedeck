/**
 * Order vocabulary shared by the strategy API, the event contracts and the simulated broker.
 *
 * These are plain string unions rather than enums: `erasableSyntaxOnly` is on so that the whole
 * repository runs under Node's native type stripping with no build step (ADR-0007), and a string
 * union serializes into a report or a database column without a lookup table.
 */

import type { Brand } from '../util/brand.ts';
import type { InstrumentId } from '../instrument.ts';
import type { PriceInt, QtyInt } from '../math/fixed.ts';

export type OrderId = Brand<number, 'OrderId'>;
export type FillId = Brand<number, 'FillId'>;

export type Side = 'buy' | 'sell';

export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';

/**
 * - `gtc` — rests until filled or cancelled.
 * - `day` — cancelled when the UTC calendar day changes. A session calendar will refine this
 *   once B3 trading hours land (roadmap); until then the day boundary is UTC midnight.
 * - `ioc` — fills what it can on its first matching opportunity, cancels the rest.
 * - `fok` — fills in full on its first matching opportunity or is cancelled untouched.
 */
export type TimeInForce = 'gtc' | 'day' | 'ioc' | 'fok';

export type OrderStatus =
  /** Accepted, waiting for its latency to elapse. Not yet matchable. */
  | 'pending'
  /** Live in the simulated book. */
  | 'working'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'rejected';

export type Liquidity = 'maker' | 'taker';

export type RejectReason =
  | 'unknown_instrument'
  | 'invalid_quantity'
  | 'invalid_price'
  | 'missing_price'
  | 'unsupported_time_in_force'
  | 'insufficient_funds'
  | 'unknown_order'
  | 'order_not_amendable';

/** True while an order can still produce fills. */
export function isOrderLive(status: OrderStatus): boolean {
  return status === 'pending' || status === 'working' || status === 'partially_filled';
}

/** A strategy's request. The broker turns it into an {@link ../execution/order.js | OrderState}. */
export interface NewOrder {
  readonly instrumentId: InstrumentId;
  readonly side: Side;
  readonly type: OrderType;
  readonly qty: QtyInt;
  /** Required for `limit` and `stop_limit`. */
  readonly limitPrice?: PriceInt | undefined;
  /** Required for `stop` and `stop_limit`. */
  readonly stopPrice?: PriceInt | undefined;
  /** Defaults to `gtc`. */
  readonly tif?: TimeInForce | undefined;
  /** Free-form label echoed on every resulting event. Use it to name the leg of a bracket. */
  readonly tag?: string | undefined;
  /**
   * One-cancels-other group. Orders sharing a group reduce each other as they fill.
   *
   * A bracket is a stop and a target that must never both execute. Building that out of two orders
   * and a `cancel` inside `onFill` works and is what this engine required until now, but it is not
   * the same thing: between the fill and the cancel the second leg is still live, and on a bar that
   * touches both levels the simulator can execute it. A venue's OCO does not have that window.
   *
   * Reduction, not cancellation, because a partial fill on one leg must leave the other covering
   * exactly what is left. A leg reduced to nothing is cancelled with reason `oco`.
   */
  readonly oco?: string | undefined;
}

/** The subset of an order a strategy may amend in place. */
export interface OrderAmend {
  readonly qty?: QtyInt | undefined;
  readonly limitPrice?: PriceInt | undefined;
  readonly stopPrice?: PriceInt | undefined;
}
