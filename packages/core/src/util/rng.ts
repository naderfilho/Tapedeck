/**
 * Deterministic pseudo-randomness.
 *
 * `Math.random` is banned in the core (see ADR-0006). Anything that needs randomness — latency
 * jitter, slippage noise, a strategy shuffling its own state — draws from an injected {@link Rng}
 * seeded from the run configuration.
 *
 * Streams are forked by label. The broker's jitter and a strategy's own draws come from
 * independent sequences derived by hashing the label into the parent seed, so adding a component
 * that consumes randomness cannot shift another component's sequence. Without this, inserting one
 * extra `nextFloat()` anywhere silently changes every downstream result.
 *
 * The generator is xoshiro128\*\*: 128 bits of state in four `uint32`s, no BigInt, and a period of
 * 2^128 - 1. It is not cryptographically secure and does not need to be.
 */

export interface Rng {
  /** Human-readable stream name, e.g. `root/broker.slippage`. */
  readonly label: string;
  /** Uniform `uint32` in `[0, 2^32)`. */
  nextU32(): number;
  /** Uniform double in `[0, 1)` with 32 bits of entropy. */
  nextFloat(): number;
  /** Uniform integer in `[minInclusive, maxExclusive)`. */
  nextInt(minInclusive: number, maxExclusive: number): number;
  /** Derives an independent stream. The same label always yields the same stream. */
  fork(label: string): Rng;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** splitmix32, used only to expand a single seed into the four words of xoshiro state. */
function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return (): number => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** FNV-1a over the label, mixed with the parent seed. Stable across platforms and versions. */
function deriveSeed(parentSeed: number, label: string): number {
  let h = (0x811c9dc5 ^ parentSeed) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = (h ^ label.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export class Xoshiro128 implements Rng {
  readonly label: string;
  private readonly seed: number;
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number, label = 'root') {
    this.seed = seed >>> 0;
    this.label = label;
    const next = splitmix32(this.seed);
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    // An all-zero state is a fixed point of the generator; splitmix32 makes it astronomically
    // unlikely, but the failure mode is silent so it is worth one comparison at construction.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 0x9e3779b9;
  }

  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  nextFloat(): number {
    return this.nextU32() / 4294967296;
  }

  nextInt(minInclusive: number, maxExclusive: number): number {
    const span = maxExclusive - minInclusive;
    if (span <= 0) return minInclusive;
    return minInclusive + Math.floor(this.nextFloat() * span);
  }

  fork(label: string): Rng {
    const childLabel = `${this.label}/${label}`;
    return new Xoshiro128(deriveSeed(this.seed, childLabel), childLabel);
  }
}

export function createRng(seed: number, label = 'root'): Rng {
  return new Xoshiro128(seed, label);
}
