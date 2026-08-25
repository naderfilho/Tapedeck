/**
 * The strategy contract.
 *
 * Every hook is synchronous and returns `void` (ADR-0003). That is not an oversight: a strategy
 * that can `await` is a strategy whose event ordering depends on the event-loop scheduler, and a
 * backtest whose event ordering is scheduler-dependent is not reproducible. If a strategy needs
 * data from outside, the fetch happens outside the kernel and its result arrives as a future
 * event.
 *
 * The bar handed to `onBar` is a reused view (ADR-0004). Read it, do not keep it. Under test and
 * in development the object is revoked when the callback returns, so keeping it fails loudly.
 */

import type {
  BarEvent,
  OrderAmendedEvent,
  OrderCancelledEvent,
  OrderFilledEvent,
  OrderRejectedEvent,
  TickEvent,
} from './events/events.ts';
import type { Instrument, InstrumentId } from './instrument.ts';
import type { BarIndicator, IndicatorHandle, UseIndicatorOptions } from './indicator.ts';
import type { MoneyInt } from './math/fixed.ts';
import type { PositionView } from './portfolio/portfolio.ts';
import type { NewOrder, OrderAmend, OrderId } from './execution/types.ts';
import type { OrderSnapshot } from './execution/order.ts';
import type { ReadonlyClock } from './time/clock.ts';
import type { TradingCalendar } from './time/calendar.ts';
import type { Timestamp } from './time/timestamp.ts';
import type { Logger } from './util/logger.ts';
import type { Rng } from './util/rng.ts';

/** Read-only projection of the account. A strategy can look; only fills can change it. */
export interface PortfolioView {
  cash(): MoneyInt;
  equity(): MoneyInt;
  realizedPnl(): MoneyInt;
  unrealizedPnl(): MoneyInt;
  marginUsed(): MoneyInt;
  position(instrumentId: InstrumentId): PositionView;
}

/**
 * Everything a strategy is allowed to touch.
 *
 * Note what is absent: the tape, the chunk, the bar index, the engine. A strategy has no way to
 * reach a bar it has not been handed, which is what makes lookahead a compile-time impossibility
 * rather than a code-review responsibility.
 */
export interface StrategyContext {
  readonly clock: ReadonlyClock;
  /**
   * The venue's sessions. `ALWAYS_OPEN` unless the run declared one.
   *
   * Present because "how long until the close" is a question strategies on a session-based venue
   * actually ask — not opening a position in the last ten minutes, flattening before a holiday —
   * and deriving it from timestamps in every strategy would mean every strategy reimplementing
   * Carnival.
   */
  readonly calendar: TradingCalendar;
  readonly log: Logger;
  /** The run's seeded random stream, forked for this strategy (ADR-0006). */
  readonly rng: Rng;
  readonly portfolio: PortfolioView;

  now(): Timestamp;
  instrument(instrumentId: InstrumentId): Instrument;
  /** Looks an instrument up by `venue` and `symbol`. Throws when it was not registered. */
  instrumentOf(venue: string, symbol: string): Instrument;

  /**
   * Registers an indicator and returns a read-only handle on its value.
   *
   * The engine updates it once per bar, after resting orders have matched and before `onBar`, so
   * the value read inside `onBar` always corresponds to the bar being shown. Registering from
   * `onInit` is the normal case and fixes the update order; registering later is allowed and the
   * indicator simply starts from the next bar.
   */
  use<T>(indicator: BarIndicator<T>, options?: UseIndicatorOptions): IndicatorHandle<T>;

  submit(order: NewOrder): OrderId;
  cancel(id: OrderId): boolean;
  replace(id: OrderId, amend: OrderAmend): boolean;
  order(id: OrderId): OrderSnapshot | undefined;
  openOrders(instrumentId?: InstrumentId): readonly OrderSnapshot[];

  /**
   * Records an intent for the report. Optional: a strategy may go straight to `submit`.
   * Emitting signals lets the report compare what was intended with what was executed.
   */
  signal(
    instrumentId: InstrumentId,
    direction: 'long' | 'short' | 'flat',
    strength?: number,
    tag?: string,
  ): void;
}

export interface Strategy<P extends object = Record<string, never>> {
  /** Stable identifier, used in reports and stored runs. */
  readonly id: string;

  /**
   * Called once, before any market data. Validate parameters and build state here.
   *
   * A paper session that restarts after a crash restores the *account* — cash, cost basis, resting
   * orders — and calls this hook on a fresh instance. Nothing a strategy kept in a field comes
   * back, and `bar.index` counts this run's bars, so it restarts at zero too. A strategy that must
   * survive a restart derives its state from event time, from its fills, and from
   * `ctx.portfolio` / `ctx.openOrders()`, all of which do come back.
   */
  onInit(ctx: StrategyContext, params: P): void;

  /** A closed bar. Runs after resting orders have been matched against it. */
  onBar?(bar: BarEvent, ctx: StrategyContext): void;

  /** A single print from the tape. Only called when the run is fed tick data. */
  onTick?(tick: TickEvent, ctx: StrategyContext): void;

  /** A fill, delivered the instant it happens — including in the middle of matching a bar. */
  onFill?(fill: OrderFilledEvent, ctx: StrategyContext): void;

  onReject?(rejection: OrderRejectedEvent, ctx: StrategyContext): void;

  onCancel?(cancellation: OrderCancelledEvent, ctx: StrategyContext): void;

  /**
   * An order changed in place — because this strategy asked, or because an OCO sibling filled and
   * reduced it. The order keeps its id and its place in the queue.
   */
  onAmend?(amendment: OrderAmendedEvent, ctx: StrategyContext): void;

  /** Called once, after the last bar and after any end-of-run flattening. */
  onStop?(ctx: StrategyContext): void;
}

/**
 * Strategies are constructed per run, never shared.
 *
 * A factory rather than an instance because a parameter sweep runs the same strategy hundreds of
 * times and state leaking between runs is the second-most-common way a backtest lies.
 */
export type StrategyFactory<P extends object = Record<string, never>> = () => Strategy<P>;
