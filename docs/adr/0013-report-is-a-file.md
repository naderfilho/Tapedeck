# 0013 — A report is a file, not an application

- Status: Accepted
- Date: 2026-08-25

## Context

The report is the artefact people actually look at. It gets emailed, attached to a pull request,
opened six months later to answer "what did we decide back then", and printed. Every one of those
uses breaks the moment it needs a server, a CDN or a runtime.

## Decision

`renderHtmlReport` returns **one string**: a complete HTML document with inline styles, inline SVG
and no `<script>` tag. It loads nothing from the network — a test asserts that the output contains
no `http`, no `src=` and no `<script`.

The charts are hand-rolled SVG. The only piece with real content is the downsampling: an equity
curve of a million points produces a path a browser refuses to render, and naive sampling — every
hundredth point — deletes exactly the spikes a risk chart exists to show. Bucketed min/max keeps
both extremes of every bucket, so the drawdown on the picture is the drawdown that happened.

**The caveats go above the results.** `stats.ambiguousBars` and the sub-bar latency count are
printed before the Sharpe ratio, in the terminal summary and at the top of the HTML. The engine
goes to some trouble to know how much of a result is a modelling assumption; burying that under a
metric card would waste the effort.

Everything that came from outside — warnings, symbols, parameters — is HTML-escaped. A run result
is a file, and a file is untrusted input.

## Alternatives considered

- **A charting library.** Chart.js, ECharts, Plotly: better charts, a hundred to a thousand
  kilobytes of JavaScript, and an artefact that renders a blank page when the CDN moves. Inlining
  the library instead makes every report a megabyte.
- **A live dashboard.** More useful while iterating and useless as a record, which is the job.
- **Markdown or PDF.** Markdown cannot draw; PDF needs a renderer that is larger than this
  entire project.

## Consequences

- Charts are static: no tooltips beyond SVG `<title>`, no zoom, no crosshair.
- The report grows with the trade list, so the table truncates at a configurable limit and says so.
  A year of hourly bars with 139 trades produces about 125 KiB.
- Anything the report needs to show has to be computed before rendering, which is why
  `renderHtmlReport` takes the metrics rather than computing them: the JSON and the HTML are then
  guaranteed to be the same numbers.
