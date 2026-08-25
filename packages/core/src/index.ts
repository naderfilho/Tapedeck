/**
 * `@tapedeck/core` — the deterministic event-driven kernel.
 *
 * Zero runtime dependencies, by design (ADR-0001). Everything an adapter, a report or a CLI needs
 * to talk to the engine is exported from here; nothing reaches into `src/`.
 */

// Numbers
export {
  type MoneyInt,
  type PriceInt,
  type QtyInt,
  type Rounding,
  type TickRounding,
  MONEY_EXP,
  MONEY_ONE,
  ZERO_MONEY,
  ZERO_PRICE,
  ZERO_QTY,
  asMoney,
  asPrice,
  asQty,
  formatFixed,
  fromFloat,
  isTickAligned,
  mulDiv,
  mulDivDiv,
  mulMulDiv,
  parseFixed,
  pow10,
  roundToTick,
  toFloat,
  weightedAverage,
} from './math/fixed.ts';

// Time
export {
  type Duration,
  type Timestamp,
  MICROS_PER_DAY,
  MICROS_PER_HOUR,
  MICROS_PER_MILLI,
  MICROS_PER_MINUTE,
  MICROS_PER_SECOND,
  asDuration,
  asTimestamp,
  formatTimeframe,
  fromIso,
  fromMillis,
  fromSeconds,
  parseTimeframe,
  toIso,
  toMillis,
  utcDayIndex,
} from './time/timestamp.ts';
export { type Clock, type ReadonlyClock, LiveClock, SimulatedClock } from './time/clock.ts';
export {
  type CalendarSpec,
  type CivilDate,
  type SessionBounds,
  type SessionSpec,
  type SpecialDay,
  ALWAYS_OPEN,
  B3,
  TradingCalendar,
  civilFromDays,
  daysFromCivil,
  easterSunday,
  weekdayOf,
} from './time/calendar.ts';
export {
  type Scheduler,
  type TimerCallback,
  type TimerId,
  SimulatedScheduler,
} from './time/scheduler.ts';

// Instruments
export {
  type AccountingMode,
  type Currency,
  type Instrument,
  type InstrumentId,
  type InstrumentKind,
  type InstrumentSpec,
  type Venue,
  INSTRUMENTS,
  InstrumentRegistry,
  b3Stock,
  resolveInstrument,
} from './instrument.ts';

// Events
export {
  type BarEvent,
  type EventBase,
  type MarketEvent,
  type OrderAcceptedEvent,
  type OrderCancelledEvent,
  type OrderEvent,
  type OrderFilledEvent,
  type OrderRejectedEvent,
  type PortfolioUpdateEvent,
  type SignalEvent,
  type TapedeckEvent,
  type TickEvent,
  EventKind,
  isTerminalStatus,
} from './events/events.ts';

// Tape
export {
  type BarChunk,
  type TickChunk,
  BarChunkBuilder,
  TickChunkBuilder,
  validateBarChunk,
} from './tape/chunk.ts';
export {
  type ViewMode,
  MutableBarView,
  MutableTickView,
  ViewGate,
  createBarGate,
  createTickGate,
} from './tape/view.ts';

// Execution
export {
  type FillId,
  type Liquidity,
  type NewOrder,
  type OrderAmend,
  type OrderId,
  type OrderStatus,
  type OrderType,
  type RejectReason,
  type Side,
  type TimeInForce,
  isOrderLive,
} from './execution/types.ts';
export {
  type OrderRejection,
  type OrderSnapshot,
  type OrderState,
  createOrderState,
  leavesQty,
  snapshotOrder,
  validateNewOrder,
} from './execution/order.ts';
export {
  type B3FuturesCostOptions,
  type BpsCommissionOptions,
  type CommissionContext,
  type CommissionModel,
  type ExecutionConfig,
  type IntrabarPolicy,
  type LatencyModel,
  type LiquidityContext,
  type LiquidityModel,
  type SlippageContext,
  type SlippageModel,
  PRESETS,
  b3FuturesCommission,
  bpsCommission,
  bpsSlippage,
  fixedLatency,
  fixedTicksSlippage,
  noCommission,
  noLatency,
  noSlippage,
  notionalOf,
  perUnitCommission,
  priceDeltaToMoney,
  rangeFractionSlippage,
  uniformLatency,
  unlimitedLiquidity,
  volumeParticipation,
  withJitter,
} from './execution/models.ts';
export {
  type Broker,
  type BrokerSink,
  type BrokerStats,
  type SimulatedBrokerOptions,
  SimulatedBroker,
} from './execution/broker.ts';

// Portfolio
export { type FillEffect, type PositionView, Portfolio } from './portfolio/portfolio.ts';
export { type TradeRecord, TradeLog } from './portfolio/trades.ts';

// Indicators
export {
  type BarIndicator,
  type BarSample,
  type Indicator,
  type IndicatorHandle,
  type PriceSource,
  type UseIndicatorOptions,
  type ValueIndicator,
  sourceOf,
} from './indicator.ts';

// Strategy
export type { PortfolioView, Strategy, StrategyContext, StrategyFactory } from './strategy.ts';

// Engine
export { type RunOptions, Engine, runBacktest, runBacktestAsync } from './engine/engine.ts';
export {
  type LiveEvent,
  type LiveSessionOptions,
  type LiveStats,
  LiveSession,
} from './engine/live.ts';
export {
  type EquityCurve,
  type EquityPoint,
  type RunConfigSummary,
  type RunResult,
  type RunStats,
  EquityRecorder,
  parseRunResult,
  serializeRunResult,
} from './engine/result.ts';

// Contracts implemented outside the core
export type {
  BarRequest,
  DataProvider,
  MarketStream,
  MarketStreamHandler,
  StreamRequest,
  StreamStatus,
  TickRequest,
} from './data.ts';
export {
  type BarCache,
  type BarCacheEntry,
  type CachedBars,
  type BarQuery,
  type PaperCounters,
  type PaperRepository,
  type PaperState,
  type RunRepository,
  type Store,
  type StoredRun,
  NullStore,
} from './store.ts';

// Utilities
export {
  type ErrorDetails,
  ErrorCode,
  ConfigError,
  IllegalStateError,
  InternalError,
  MarketDataError,
  NotFoundError,
  OrderError,
  PrecisionError,
  UpstreamError,
  TapedeckError,
} from './util/errors.ts';
export { type LogEntry, type LogLevel, type Logger, BufferedLogger } from './util/logger.ts';
export { type Rng, Xoshiro128, createRng } from './util/rng.ts';
export { STRICT } from './util/assert.ts';

// Futures contracts
export {
  type Contract,
  type ContractSeries,
  type ExpiryRule,
  B3_SERIES,
  MONTH_CODES,
  contractOf,
  contractSymbol,
  contractsBetween,
  frontContract,
  monthCode,
  monthOfCode,
  parseContractSymbol,
} from './contract.ts';
