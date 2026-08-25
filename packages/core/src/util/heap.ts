import { unreachable } from './assert.ts';

/**
 * Binary min-heap ordered by a composite numeric key `(a, b)`.
 *
 * The engine uses it as the scheduler's priority queue with `a = timestamp` and `b = sequence`.
 * The sequence is what makes the order *total*: two events at the same simulated microsecond still
 * have exactly one possible ordering, which is the whole basis of the determinism guarantee.
 *
 * Keys live in parallel arrays rather than in the payload objects so that comparisons touch
 * numbers only.
 */
export class MinHeap<T> {
  private readonly keysA: number[] = [];
  private readonly keysB: number[] = [];
  private readonly items: T[] = [];

  get size(): number {
    return this.items.length;
  }

  push(a: number, b: number, item: T): void {
    this.keysA.push(a);
    this.keysB.push(b);
    this.items.push(item);
    this.siftUp(this.items.length - 1);
  }

  /** Primary key of the next item, or `undefined` when empty. */
  peekKeyA(): number | undefined {
    return this.keysA[0];
  }

  peek(): T | undefined {
    return this.items[0];
  }

  pop(): T | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;
    const top = this.items[0] ?? unreachable('heap item missing');
    const lastItem = this.items.pop() ?? unreachable('heap item missing');
    const lastA = this.keysA.pop() ?? unreachable('heap key missing');
    const lastB = this.keysB.pop() ?? unreachable('heap key missing');
    if (n > 1) {
      this.items[0] = lastItem;
      this.keysA[0] = lastA;
      this.keysB[0] = lastB;
      this.siftDown(0);
    }
    return top;
  }

  clear(): void {
    this.keysA.length = 0;
    this.keysB.length = 0;
    this.items.length = 0;
  }

  private less(i: number, j: number): boolean {
    const ai = this.keysA[i] ?? unreachable('heap key missing');
    const aj = this.keysA[j] ?? unreachable('heap key missing');
    if (ai !== aj) return ai < aj;
    const bi = this.keysB[i] ?? unreachable('heap key missing');
    const bj = this.keysB[j] ?? unreachable('heap key missing');
    return bi < bj;
  }

  private swap(i: number, j: number): void {
    const ai = this.keysA[i] ?? unreachable('heap key missing');
    const bi = this.keysB[i] ?? unreachable('heap key missing');
    const vi = this.items[i] ?? unreachable('heap item missing');
    this.keysA[i] = this.keysA[j] ?? unreachable('heap key missing');
    this.keysB[i] = this.keysB[j] ?? unreachable('heap key missing');
    this.items[i] = this.items[j] ?? unreachable('heap item missing');
    this.keysA[j] = ai;
    this.keysB[j] = bi;
    this.items[j] = vi;
  }

  private siftUp(start: number): void {
    let i = start;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(start: number): void {
    const n = this.items.length;
    let i = start;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && this.less(left, smallest)) smallest = left;
      if (right < n && this.less(right, smallest)) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }
}
