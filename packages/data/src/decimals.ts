/**
 * Reading a venue's decimals without losing any.
 *
 * Every provider here has to answer the same two questions about the strings an exchange publishes
 * — how many decimals does this increment really have, and what does this number look like written
 * out — so the answers live in one place rather than once per venue.
 */

/**
 * Binance quotes its increments with trailing zeros — `"0.01000000"` — and the number of
 * *significant* decimals is the instrument's true scale. Reading the string length instead would
 * declare BTCUSDT as having eight decimals of price and inflate every fixed-point value by a
 * million.
 */
export function decimalsOf(value: string): number {
  const dot = value.indexOf('.');
  if (dot === -1) return 0;
  const fraction = value.slice(dot + 1).replace(/0+$/, '');
  return fraction.length;
}

/** Strips trailing zeros so a spec reads like the contract sheet rather than like a wire format. */
export function trimZeros(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '');
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * A finite number as a plain decimal string, never in exponential notation.
 *
 * For a venue that publishes JSON *numbers* rather than strings — Coinbase does — the exactness a
 * string would have preserved is already spent by the time the body is parsed. What is left is to
 * not spend any more: `String(n)` on a double is the shortest decimal that round-trips back to the
 * same double, so it introduces no second error. The only thing it gets wrong is the form, and
 * only at the extremes: past 1e21 and below 1e-7 it switches to `1.2e-8`, which the fixed-point
 * parser cannot read. This writes those out in full instead.
 */
export function decimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`cannot write ${String(value)} as a decimal string`);
  }
  const text = String(value);
  const exponent = text.indexOf('e');
  if (exponent === -1) return text;

  const power = Number(text.slice(exponent + 1));
  const mantissa = text.slice(0, exponent);
  const negative = mantissa.startsWith('-');
  const digits = negative ? mantissa.slice(1) : mantissa;
  const dot = digits.indexOf('.');
  const whole = dot === -1 ? digits : digits.slice(0, dot);
  const fraction = dot === -1 ? '' : digits.slice(dot + 1);
  const sign = negative ? '-' : '';

  // Both branches can only run out of digits if the two cases below were reachable, and neither is:
  // `String` writes a double in exponential form only above 1e21 or below 1e-7, and in both cases
  // the mantissa is a single digit followed by at most sixteen more. So a positive exponent always
  // has more zeros to give than the fraction has digits to absorb, and a negative one always has
  // room for the leading zeros. Should that ever stop holding, `repeat` throws rather than
  // returning a number quietly missing a digit.
  if (power >= 0) return `${sign}${whole}${fraction}${'0'.repeat(power - fraction.length)}`;
  return `${sign}0.${'0'.repeat(-power - whole.length)}${whole}${fraction}`;
}
