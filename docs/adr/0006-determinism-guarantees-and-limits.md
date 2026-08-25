# 0006 — Determinism guarantees and their limits

- Status: Accepted
- Date: 2026-08-25

## Context

The project claims byte-for-byte reproducibility. A claim like that is worth exactly as much as
its stated limits.

## Decision

### What is guaranteed

Given the same input data, the same configuration and the same seed, a run produces an identical
trade list, equity curve and order/fill log — byte for byte — regardless of how the input was
chunked and regardless of the machine.

The mechanisms:

- No `Date.now()` and no `Math.random()` anywhere in `packages/core`; both are blocked by lint.
  Time comes from an injected `Clock`, randomness from an injected `Rng` (xoshiro128ss, seeded
  from configuration).
- Random streams are **forked by label**: the broker's slippage jitter and a strategy's own
  randomness draw from independent streams derived by hashing the label into the seed. Adding a
  component cannot shift another component's sequence.
- A total order on events, `(timestamp, seq)` with a monotonic `seq`. No two events compare equal.
- Insertion-ordered `Map` and `Set` only, sequential integer IDs, and no iteration over plain
  object keys in ordering-sensitive code.
- Chunk invariance is asserted by a test that feeds the same dataset as one chunk and as many
  uneven chunks, then compares the serialized results.

### What is not guaranteed

Indicator and metric math runs in float64. Addition, subtraction, multiplication, division and
`sqrt` are exactly specified by IEEE-754 and reproduce bit for bit for a fixed operation order.
`Math.pow`, `Math.exp` and `Math.log` are **not** specified to the last bit and may differ across
V8 versions. CAGR and Sortino use `pow`.

Therefore:

- The strict determinism test compares the equity curve, the trade list and the fill log, all of
  which are exact fixed-point values.
- Golden files for derived metrics are compared at a documented tolerance (12 significant digits),
  and the Node version that generated them is recorded alongside.

## Alternatives considered

- **Claiming bit-identity for everything.** It would be false, and a reviewer who knows that
  `Math.pow` is implementation-defined would rightly distrust the rest of the README.
- **Software floating point for metrics.** Removes the caveat at a large complexity cost, for
  numbers that are read to two decimal places.

## Consequences

- The README states the guarantee and the exception side by side.
- Any new dependency on a transcendental function in the _execution_ path, as opposed to the
  reporting path, needs its own ADR.
