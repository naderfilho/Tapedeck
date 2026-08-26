# 0016 — The report page recomputes the run it is asked for

- Status: Accepted
- Date: 2026-08-26
- Amends: [0013](0013-report-is-a-file.md)

## Context

ADR-0013 made a report a file: one HTML document, inline styles and SVG, no `<script>`, no network
request. That decision is about the artefact `renderHtmlReport` produces, and it still holds.

The published site copied that artefact to `/report/` and served it unchanged. So a visitor who
picked Ethereum in the demo, pressed Run, and clicked through to the report was shown a Bitcoin
report, because the file was the CLI example regenerated at build time. It was an honest record and
a confusing page. A report that does not describe the run you just did is a report about somebody
else's run, and nothing on the page said so.

Two properties of this engine make a better answer available. It is deterministic, so a run can be
described by its configuration and reproduced exactly from it. And the whole kernel already runs in
the browser, because core, indicators and report import nothing from `node:`.

## Decision

The site's copy of the report carries a script. It reads a run configuration from the query string,
re-runs the backtest in the tab, calls the same `renderHtmlReport` the command line calls, and swaps
the rendered `<main>` into the page. With no parameters it leaves the published example in place and
says that is what it is.

**Only the configuration travels.** Never the result. The receiving page recomputes.

The two line charts get the same crosshair the demo has, added to the SVG from outside it by
`demo/src/cursor.ts`. A download button hands over exactly the string `renderHtmlReport` returned.

`demo/src/run.ts` is the single place a run is constructed, imported by both pages. Sizing, seed,
execution preset and initial cash live there and neither page keeps a copy.

## What ADR-0013 keeps

- `renderHtmlReport` still returns one self-contained document with no `<script>` and no network
  request. The test asserting it is unchanged and still passes.
- `out/report.html`, the file the CLI writes and the one you email, is untouched.
- The download button produces that same file, inert and complete.

## What changes

The page at `/report/` on the site is an application. Saving it from the browser gives you something
that needs `report.js` next to it. The Download button exists because that is now a real trap, and
it is the only way to get the file ADR-0013 describes.

## Alternatives considered

- **Send the result instead of the configuration.** An equity curve is typed arrays; serialising it
  is lossy, large and slow. Worse, a stored result can disagree with what the engine currently
  produces, and the disagreement is invisible. A configuration cannot go stale.
- **Render on a server per request.** Needs a server. The site is static files, which is most of why
  it costs nothing to host and cannot break in a way that takes the demo with it.
- **Leave `/report/` static and add a separate page for your run.** Two pages differing only in
  provenance, and a navigation bar that has to explain which is which.
- **Make `renderHtmlReport` emit interactive SVG.** This is the thing ADR-0013 forbids, and it would
  put a script inside the file people attach to a pull request.

## Consequences

- A report URL is shareable, and anyone opening it recomputes the identical numbers rather than
  being told them.
- The demo and the report must construct runs identically. That is a correctness requirement, not a
  cosmetic one, which is why they share one function rather than two matching ones.
- A deep link is untrusted input. `fromQuery` validates every field against the same bounds the form
  enforces and returns `null` on anything unexpected, falling back to the published example. It does
  not repair a broken link, because a silently repaired link renders a run nobody asked for.
- The recompute costs a tape fetch plus about 50 ms. The report is no longer instant on a cold load.
