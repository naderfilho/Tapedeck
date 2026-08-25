/**
 * Nominal typing helper.
 *
 * The engine passes a lot of bare numbers around — prices, quantities, money, timestamps — that
 * are all `number` at runtime but must never be mixed up. Branding makes the compiler reject
 * `commission = price` without any runtime cost.
 */

declare const BRAND: unique symbol;

export type Brand<T, B extends string> = T & { readonly [BRAND]: B };
