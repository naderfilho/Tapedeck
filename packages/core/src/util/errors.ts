/**
 * Typed errors. Every failure the engine can produce carries a stable machine-readable code so
 * callers can branch on it, plus a message written for a human reading a terminal.
 */

export const ErrorCode = {
  /** A configuration value is missing, contradictory or out of range. */
  InvalidConfig: 'INVALID_CONFIG',
  /** Market data violates an invariant (out of order, high below low, non-integer price). */
  InvalidMarketData: 'INVALID_MARKET_DATA',
  /** An order was rejected before reaching the book. */
  InvalidOrder: 'INVALID_ORDER',
  /** A fixed-point operation would lose precision or overflow the safe-integer range. */
  PrecisionLost: 'PRECISION_LOST',
  /** A referenced instrument, order or strategy does not exist. */
  NotFound: 'NOT_FOUND',
  /** The engine was driven out of its allowed lifecycle order. */
  IllegalState: 'ILLEGAL_STATE',
  /** A code path that should be unreachable was reached. Always a bug in Tapedeck. */
  Internal: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export type ErrorDetails = Readonly<Record<string, unknown>>;

export class TapedeckError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }

  /** Stable, log-friendly shape. Key order is fixed so it can be diffed across runs. */
  toJSON(): { name: string; code: ErrorCode; message: string; details: ErrorDetails } {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export class ConfigError extends TapedeckError {
  constructor(message: string, details?: ErrorDetails) {
    super(ErrorCode.InvalidConfig, message, details);
  }
}

export class MarketDataError extends TapedeckError {
  constructor(message: string, details?: ErrorDetails) {
    super(ErrorCode.InvalidMarketData, message, details);
  }
}

export class OrderError extends TapedeckError {
  constructor(message: string, details?: ErrorDetails) {
    super(ErrorCode.InvalidOrder, message, details);
  }
}

export class PrecisionError extends TapedeckError {
  constructor(message: string, details?: ErrorDetails) {
    super(ErrorCode.PrecisionLost, message, details);
  }
}

export class NotFoundError extends TapedeckError {
  constructor(message: string, details?: ErrorDetails) {
    super(ErrorCode.NotFound, message, details);
  }
}

export class IllegalStateError extends TapedeckError {
  constructor(message: string, details?: ErrorDetails) {
    super(ErrorCode.IllegalState, message, details);
  }
}

export class InternalError extends TapedeckError {
  constructor(message: string, details?: ErrorDetails) {
    super(ErrorCode.Internal, message, details);
  }
}
