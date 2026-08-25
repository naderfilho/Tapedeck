/**
 * Fixed-point arithmetic. See ADR-0002.
 *
 * Prices, quantities and money are integers scaled by a power of ten. Integers below 2^53 are
 * exact in a JavaScript `number`, so addition, subtraction and comparison — everything the hot
 * loop does — are exact and as fast as arithmetic gets on V8.
 *
 * Multiplication is the dangerous operation: `priceInt * qtyInt` overflows the safe range at
 * realistic crypto precision. Every multiplication therefore goes through {@link mulDiv} or
 * {@link mulMulDiv}, which round explicitly and choose their arithmetic by inspection: plain
 * integers while every intermediate is exactly representable, `bigint` the moment one is not.
 * Both paths are exact and agree by construction; a property test asserts that they agree in
 * practice too.
 */

import type { Brand } from '../util/brand.ts';
import { PrecisionError } from '../util/errors.ts';
import { STRICT } from '../util/assert.ts';

/** A price in units of `10 ** -instrument.priceExp`. */
export type PriceInt = Brand<number, 'PriceInt'>;
/** A quantity in units of `10 ** -instrument.qtyExp`. */
export type QtyInt = Brand<number, 'QtyInt'>;
/** An amount of money in units of `10 ** -MONEY_EXP`, currency implied by context. */
export type MoneyInt = Brand<number, 'MoneyInt'>;

/** Money is always scaled by 1e8, whatever the currency. */
export const MONEY_EXP = 8;
/** One currency unit expressed as {@link MoneyInt}. */
export const MONEY_ONE = 100_000_000 as MoneyInt;
export const ZERO_MONEY = 0 as MoneyInt;
export const ZERO_QTY = 0 as QtyInt;
export const ZERO_PRICE = 0 as PriceInt;

/**
 * Rounding mode. `half-up` rounds halves away from zero (the convention used for money on every
 * exchange we care about); `half-even` is the unbiased default for internal conversions.
 */
export type Rounding = 'trunc' | 'floor' | 'ceil' | 'half-up' | 'half-even';

const POW10: readonly number[] = [
  1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15,
];

export function pow10(exp: number): number {
  const value = POW10[exp];
  if (value === undefined) {
    throw new PrecisionError(`exponent out of range: ${String(exp)} (supported: 0..15)`, { exp });
  }
  return value;
}

function checkSafe(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new PrecisionError(`${what} is not a safe integer: ${String(value)}`, { value, what });
  }
  return value;
}

/** Tags a raw integer as a price. Validates the safe-integer invariant in strict mode. */
export function asPrice(raw: number): PriceInt {
  if (STRICT) checkSafe(raw, 'price');
  return raw as PriceInt;
}

export function asQty(raw: number): QtyInt {
  if (STRICT) checkSafe(raw, 'quantity');
  return raw as QtyInt;
}

export function asMoney(raw: number): MoneyInt {
  if (STRICT) checkSafe(raw, 'money');
  return raw as MoneyInt;
}

const FIXED_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

/**
 * Parses a decimal string into a fixed-point integer without ever creating a float.
 *
 * This is the only conversion that is exact for every input, which is why data adapters are
 * expected to keep raw values as strings until they reach this function.
 */
export function parseFixed(input: string, exp: number): number {
  const text = input.trim();
  const match = FIXED_RE.exec(text);
  if (match === null) {
    throw new PrecisionError(`not a decimal number: ${JSON.stringify(input)}`, { input });
  }
  const negative = match[1] === '-';
  const intPart = match[2] ?? '0';
  const fracPart = match[3] ?? '';

  let magnitude: bigint;
  if (fracPart.length <= exp) {
    magnitude = BigInt(intPart + fracPart.padEnd(exp, '0'));
  } else {
    // More decimals than the scale can hold: round half-up on the first dropped digit.
    magnitude = BigInt(intPart + fracPart.slice(0, exp));
    const firstDropped = fracPart.charCodeAt(exp);
    if (firstDropped >= 0x35) magnitude += 1n;
  }
  return toSafeNumber(negative ? -magnitude : magnitude, 'parseFixed');
}

/** Renders a fixed-point integer with exactly `exp` decimals. Never uses float arithmetic. */
export function formatFixed(value: number, exp: number): string {
  checkSafe(value, 'fixed value');
  if (exp === 0) return String(value);
  const negative = value < 0;
  const digits = Math.abs(value)
    .toString()
    .padStart(exp + 1, '0');
  const head = digits.slice(0, digits.length - exp);
  const tail = digits.slice(digits.length - exp);
  return `${negative ? '-' : ''}${head}.${tail}`;
}

/**
 * Converts a float to fixed point. Lossy by construction — prefer {@link parseFixed}.
 * Exists for tests, benchmarks and interactive use, not for ingesting real market data.
 */
export function fromFloat(value: number, exp: number, rounding: Rounding = 'half-up'): number {
  if (!Number.isFinite(value)) {
    throw new PrecisionError(`cannot convert non-finite value: ${String(value)}`, { value });
  }
  const scaled = value * pow10(exp);
  let rounded: number;
  switch (rounding) {
    case 'trunc':
      rounded = Math.trunc(scaled);
      break;
    case 'floor':
      rounded = Math.floor(scaled);
      break;
    case 'ceil':
      rounded = Math.ceil(scaled);
      break;
    case 'half-up':
      rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
      break;
    case 'half-even': {
      const floor = Math.floor(scaled);
      const frac = scaled - floor;
      if (frac > 0.5) rounded = floor + 1;
      else if (frac < 0.5) rounded = floor;
      else rounded = floor % 2 === 0 ? floor : floor + 1;
      break;
    }
  }
  // `-0` would serialize as "-0" and break byte-for-byte comparison of golden files.
  return checkSafe(rounded === 0 ? 0 : rounded, 'fromFloat');
}

/** Converts fixed point back to a float. Lossy for magnitudes above 2^53 / 10^exp. */
export function toFloat(value: number, exp: number): number {
  return value / pow10(exp);
}

function toSafeNumber(value: bigint, what: string): number {
  if (value > 9007199254740991n || value < -9007199254740991n) {
    throw new PrecisionError(`${what} overflowed the safe-integer range: ${value.toString()}`, {
      value: value.toString(),
      what,
    });
  }
  return Number(value);
}

function toBigInt(value: number, what: string): bigint {
  if (!Number.isInteger(value)) {
    throw new PrecisionError(`${what} must be an integer, got ${String(value)}`, { value, what });
  }
  return BigInt(value);
}

/** Divides `n` by a positive `d`, applying `mode` to the remainder. */
function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
  if (d <= 0n) throw new PrecisionError('divisor must be positive', { divisor: d.toString() });
  const negative = n < 0n;
  const magnitude = negative ? -n : n;
  const quotient = magnitude / d;
  const remainder = magnitude % d;

  let result: bigint;
  switch (mode) {
    case 'trunc':
      result = quotient;
      break;
    case 'floor':
      result = negative && remainder !== 0n ? quotient + 1n : quotient;
      break;
    case 'ceil':
      result = !negative && remainder !== 0n ? quotient + 1n : quotient;
      break;
    case 'half-up':
      result = remainder * 2n >= d ? quotient + 1n : quotient;
      break;
    case 'half-even': {
      const twice = remainder * 2n;
      if (twice > d) result = quotient + 1n;
      else if (twice < d) result = quotient;
      else result = quotient % 2n === 0n ? quotient : quotient + 1n;
      break;
    }
  }
  return negative ? -result : result;
}

/**
 * The same rounding rules as {@link divRound}, on plain integers.
 *
 * `Math.floor(m / d)` can be off by one when the true quotient sits a hair below an integer, so
 * the quotient is corrected against an exactly computed remainder. `q * d` cannot overflow,
 * because `q * d <= m` and `m` is already a safe integer, which makes the correction exact.
 */
function divRoundSafe(n: number, d: number, mode: Rounding): number {
  const negative = n < 0;
  const magnitude = negative ? -n : n;
  let quotient = Math.floor(magnitude / d);
  let remainder = magnitude - quotient * d;
  if (remainder < 0) {
    quotient--;
    remainder += d;
  } else if (remainder >= d) {
    quotient++;
    remainder -= d;
  }

  let result: number;
  switch (mode) {
    case 'trunc':
      result = quotient;
      break;
    case 'floor':
      result = negative && remainder !== 0 ? quotient + 1 : quotient;
      break;
    case 'ceil':
      result = !negative && remainder !== 0 ? quotient + 1 : quotient;
      break;
    case 'half-up':
      result = remainder * 2 >= d ? quotient + 1 : quotient;
      break;
    case 'half-even': {
      const twice = remainder * 2;
      if (twice > d) result = quotient + 1;
      else if (twice < d) result = quotient;
      else result = quotient % 2 === 0 ? quotient : quotient + 1;
      break;
    }
  }
  // `-0` is a real value in float64 and not in bigint, so returning it here would make the fast
  // and slow paths disagree under `Object.is` and leak a signed zero into the ledger.
  if (result === 0) return 0;
  return negative ? -result : result;
}

/**
 * `a * b / d`, exact intermediate, explicit rounding.
 *
 * Takes a plain-arithmetic fast path whenever every intermediate stays inside the exactly
 * representable integer range, and falls back to `bigint` when it does not. Both paths produce
 * the same value by construction, and a property test asserts it on random inputs.
 */
export function mulDiv(a: number, b: number, d: number, mode: Rounding = 'half-even'): number {
  const product = a * b;
  if (
    Number.isInteger(a) &&
    Number.isInteger(b) &&
    Number.isSafeInteger(product) &&
    Number.isInteger(d) &&
    d > 0
  ) {
    return divRoundSafe(product, d, mode);
  }
  const exact = toBigInt(a, 'operand') * toBigInt(b, 'operand');
  return toSafeNumber(divRound(exact, toBigInt(d, 'divisor'), mode), 'mulDiv');
}

/** `a * b * c / d`, exact intermediate, explicit rounding. Same fast path as {@link mulDiv}. */
export function mulMulDiv(
  a: number,
  b: number,
  c: number,
  d: number,
  mode: Rounding = 'half-even',
): number {
  const partial = a * b;
  if (
    Number.isInteger(a) &&
    Number.isInteger(b) &&
    Number.isInteger(c) &&
    Number.isSafeInteger(partial) &&
    Number.isInteger(d) &&
    d > 0
  ) {
    const product = partial * c;
    if (Number.isSafeInteger(product)) return divRoundSafe(product, d, mode);
  }
  const exact = toBigInt(a, 'operand') * toBigInt(b, 'operand') * toBigInt(c, 'operand');
  return toSafeNumber(divRound(exact, toBigInt(d, 'divisor'), mode), 'mulMulDiv');
}

/** `a * b / (d1 * d2)`, exact intermediate. Used to invert a two-scale conversion in one step. */
export function mulDivDiv(
  a: number,
  b: number,
  d1: number,
  d2: number,
  mode: Rounding = 'half-even',
): number {
  const divisor = toBigInt(d1, 'divisor') * toBigInt(d2, 'divisor');
  const product = toBigInt(a, 'operand') * toBigInt(b, 'operand');
  return toSafeNumber(divRound(product, divisor, mode), 'mulDivDiv');
}

/**
 * `(v1 * w1 + v2 * w2) / (w1 + w2)` with an exact intermediate.
 * Used for the volume-weighted average entry price of a position.
 */
export function weightedAverage(v1: number, w1: number, v2: number, w2: number): number {
  const totalWeight = toBigInt(w1, 'weight') + toBigInt(w2, 'weight');
  if (totalWeight === 0n) return 0;
  const numerator =
    toBigInt(v1, 'value') * toBigInt(w1, 'weight') + toBigInt(v2, 'value') * toBigInt(w2, 'weight');
  return toSafeNumber(divRound(numerator, totalWeight, 'half-even'), 'weightedAverage');
}

export type TickRounding = 'nearest' | 'down' | 'up' | 'toward-zero';

/**
 * Snaps a price to a multiple of the instrument tick size.
 *
 * This is the boundary between the float world of indicators and the integer world of the ledger
 * (ADR-0002): an indicator value only becomes an order price by passing through here. `%` on
 * integers within the safe range is exact, so no bigint is needed.
 */
export function roundToTick(value: number, tick: number, mode: TickRounding = 'nearest'): number {
  if (tick <= 0) throw new PrecisionError('tick size must be positive', { tick });
  let remainder = value % tick;
  if (remainder === 0) return value;
  if (remainder < 0) remainder += tick;
  const down = value - remainder;
  const up = down + tick;
  switch (mode) {
    case 'down':
      return down;
    case 'up':
      return up;
    case 'toward-zero':
      return value < 0 ? up : down;
    case 'nearest':
      return remainder * 2 >= tick ? up : down;
  }
}

/** True when `value` is an exact multiple of `tick`. */
export function isTickAligned(value: number, tick: number): boolean {
  return value % tick === 0;
}
