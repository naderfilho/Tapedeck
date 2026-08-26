/**
 * The crosshair, shared by the demo and the report.
 *
 * It lives here because the two pages have to behave identically. The report's charts came out of
 * `renderHtmlReport` as inert SVG while the demo's reacted to the pointer, and a reader moving
 * between them finds one of the two broken, and cannot tell that one is a generated record and
 * the other a live page, nor should they have to.
 *
 * The interactivity is added to the SVG from outside rather than baked into it. That is the whole
 * trick: `renderHtmlReport` still emits one self-contained document with no `<script>`, and the
 * file you download from the report page is that document, inert and complete. What reacts is the
 * page around it (ADR-0016).
 */

import type { Bounds, Box, Series } from '@tapedeck/report';
import { scaleX, scaleY } from '@tapedeck/report';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Everything the cursor needs to answer "what is under the pointer" without recomputing a run. */
export interface CursorState {
  readonly box: Box;
  readonly bounds: Bounds;
  readonly series: Series;
  readonly formatValue: (value: number) => string;
}

/** Index of the point nearest an x in chart user units. The series is sorted, so this bisects. */
function nearestIndex(state: CursorState, userX: number): number {
  const { series, bounds, box } = state;
  const span = bounds.maxX - bounds.minX;
  const usable = box.width - box.left - box.right;
  const targetX = bounds.minX + ((userX - box.left) / usable) * span;

  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((series.xs[mid] ?? 0) < targetX) lo = mid + 1;
    else hi = mid;
  }
  const before = Math.max(0, lo - 1);
  const dBefore = Math.abs((series.xs[before] ?? 0) - targetX);
  const dAt = Math.abs((series.xs[lo] ?? 0) - targetX);
  return dBefore < dAt ? before : lo;
}

const isoDay = (micros: number): string => new Date(micros / 1000).toISOString().slice(0, 10);

/**
 * Adds the crosshair line and dot to an SVG that does not have them.
 *
 * The demo renders them in its own markup; the report's charts arrive without, because the function
 * that drew them is not allowed to emit anything interactive. Either way the elements end up
 * identical, so one stylesheet dresses both.
 */
export function ensureCursorGroup(svg: SVGSVGElement, box: Box): void {
  if (svg.querySelector('.cursor') !== null) return;

  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'cursor');
  group.setAttribute('aria-hidden', 'true');

  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('class', 'cursor-line');
  line.setAttribute('y1', String(box.top));
  line.setAttribute('y2', String(box.height - box.bottom));

  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'cursor-dot');
  dot.setAttribute('r', '4');

  group.append(line, dot);
  svg.append(group);
}

const readouts = new WeakMap<HTMLElement, HTMLElement>();

/**
 * The floating value box for one panel, created once and kept across re-renders.
 *
 * Owned here rather than by the caller because drawing a chart replaces the panel's `innerHTML`.
 * The first version created the box at wiring time and the first re-run detached it: the pointer
 * handler went on writing into a node no longer in the document, so the crosshair worked exactly
 * once, before anyone changed a parameter.
 */
export function readoutFor(panel: HTMLElement): HTMLElement {
  const existing = readouts.get(panel);
  if (existing !== undefined) return existing;
  const readout = document.createElement('div');
  readout.className = 'readout';
  readout.setAttribute('aria-hidden', 'true');
  readouts.set(panel, readout);
  return readout;
}

/**
 * Wires pointer tracking for one panel.
 *
 * `resolve` is called per event rather than captured, so a panel that is redrawn with a new series
 * needs no re-wiring: the listener stays, and the data it reads is whatever the page last set.
 *
 * Pointer events rather than mouse events, so a touch drag reads the series too. The readout is an
 * HTML element rather than SVG `<text>` because it has to be measured and clamped against the panel
 * edge, and the browser does that better than arithmetic on a viewBox would.
 */
export function attachCursor(panel: HTMLElement, resolve: () => CursorState | null): void {
  const readout = readoutFor(panel);

  const hide = (): void => {
    panel.classList.remove('is-tracking');
  };
  panel.addEventListener('pointerleave', hide);
  panel.addEventListener('pointercancel', hide);

  panel.addEventListener('pointermove', (event: PointerEvent) => {
    const state = resolve();
    const svg = panel.querySelector('svg');
    if (state === null || svg === null) return;

    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const { box } = state;
    const userX = ((event.clientX - rect.left) / rect.width) * box.width;
    const clamped = Math.min(Math.max(userX, box.left), box.width - box.right);

    const index = nearestIndex(state, clamped);
    const x = scaleX(state.series.xs[index] ?? 0, state.bounds, box);
    const value = state.series.ys[index] ?? 0;
    const y = scaleY(value, state.bounds, box);

    const line = svg.querySelector('.cursor-line');
    const dot = svg.querySelector('.cursor-dot');
    line?.setAttribute('x1', x.toFixed(2));
    line?.setAttribute('x2', x.toFixed(2));
    dot?.setAttribute('cx', x.toFixed(2));
    dot?.setAttribute('cy', y.toFixed(2));

    readout.innerHTML =
      `<span class="readout__date">${isoDay(state.series.xs[index] ?? 0)}</span>` +
      `<span class="readout__value">${state.formatValue(value)}</span>`;

    // Positioned in CSS pixels against the panel, then kept inside it.
    const px = (x / box.width) * rect.width + (rect.left - panel.getBoundingClientRect().left);
    const half = readout.offsetWidth / 2;
    const maxLeft = panel.clientWidth - readout.offsetWidth - 4;
    readout.style.left = `${String(Math.min(Math.max(px - half, 4), Math.max(4, maxLeft)))}px`;
    panel.classList.add('is-tracking');
  });
}
