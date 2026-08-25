/**
 * `@tapedeck/indicators` — incremental technical indicators.
 *
 * Every indicator here updates in O(1) per bar and never looks at the series again. That is the
 * whole design constraint: an engine that replays a million bars cannot afford an indicator that
 * recomputes its window, and a live session cannot afford one that needs the history it does not
 * have.
 *
 * The correctness argument is a property test rather than a table of expected values: for any
 * random series, the incremental result must equal a deliberately naive implementation that
 * recomputes from scratch on every bar. That test is what makes "incremental" a claim rather than
 * an intention.
 *
 * ## Two conventions
 *
 * - **Classes take numbers, factories take bars.** `new Ema(20)` smooths any number stream;
 *   `ema({ period: 20 })` smooths a bar's close and is what `ctx.use()` expects.
 * - **Values stay in the instrument's price scale.** An indicator over `BTCUSDT` is denominated in
 *   cents, like the prices it consumed. Crossing back into the ledger means `roundToTick`.
 */

export {
  type RollingStatsValue,
  Ema,
  Rma,
  RollingStats,
  Sma,
  SmoothedAverage,
} from './primitives.ts';

export {
  type BollingerValue,
  type MacdValue,
  type VwapOptions,
  Atr,
  BollingerBands,
  Macd,
  Rsi,
  Vwap,
} from './indicators.ts';

export {
  type BollingerOptions,
  type MacdOptions,
  type PeriodOptions,
  SourcedIndicator,
  atr,
  bollinger,
  ema,
  fromSource,
  macd,
  rma,
  rsi,
  sma,
  stats,
  vwap,
} from './factories.ts';
