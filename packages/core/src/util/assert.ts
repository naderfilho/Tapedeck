import { InternalError, IllegalStateError } from './errors.ts';

/**
 * Strict mode turns on the checks that cost time but catch the bugs that matter: bar-view
 * retention, market-data validation, fixed-point range assertions.
 *
 * On by default everywhere except `NODE_ENV=production`. Set `TAPEDECK_STRICT=0` to force it off
 * (the benchmark does) or `TAPEDECK_STRICT=1` to force it on.
 */
function resolveStrict(): boolean {
  const flag = process.env['TAPEDECK_STRICT'];
  if (flag === '1') return true;
  if (flag === '0') return false;
  return process.env['NODE_ENV'] !== 'production';
}

export const STRICT: boolean = resolveStrict();

/** Narrows `condition` and throws an {@link IllegalStateError} when it does not hold. */
export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new IllegalStateError(message);
}

/**
 * Marks a branch the type system cannot prove impossible.
 *
 * Used instead of a non-null assertion when reading typed-array columns: `noUncheckedIndexedAccess`
 * widens those reads to `number | undefined`, and an out-of-bounds read really does produce
 * `undefined` at runtime, so the check is real rather than ceremonial.
 */
export function unreachable(message = 'unreachable'): never {
  throw new InternalError(message);
}

/** Exhaustiveness helper for discriminated unions. */
export function assertNever(value: never, message = 'unexpected variant'): never {
  throw new InternalError(`${message}: ${JSON.stringify(value)}`);
}
