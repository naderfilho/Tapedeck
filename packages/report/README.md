# @tapedeck/report

Metrics with stated conventions, JSON output, and a self-contained HTML report.

Part of [Tapedeck](../../README.md). See **[the API guide](../../docs/api.md)** for how the pieces
fit together, and the [ADRs](../../docs/adr/) for why they are shaped this way.

**Runtime dependencies:** None.

```ts
const metrics = computeMetrics(result, { periodsPerYear: 252 * 36 });
console.log(formatMetrics(metrics, 'BRL'));
writeFileSync('report.html', renderHtmlReport(result, metrics));
```

The report is **one file**: no `<script>`, no CDN, no network. It opens from a USB stick in five
years ([ADR-0013](../../docs/adr/0013-report-is-a-file.md)). A live one is published at
<https://naderfilho.github.io/Tapedeck/>.

Every metric states its convention, and reports nothing rather than something when the data cannot
support it ([ADR-0012](../../docs/adr/0012-metric-conventions.md)). `breakEvenCommissionPerUnit` is
the commission at which a run's profit reaches zero — the cost figure that does not depend on
knowing the real tariff.

## Licence

[PolyForm Noncommercial 1.0.0](../../LICENSE.md).
