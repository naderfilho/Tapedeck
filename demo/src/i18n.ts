/**
 * Portuguese for the interface, English for the terms of the trade.
 *
 * The rule that matters is what does **not** get translated. Drawdown, profit factor, Sharpe,
 * equity, backtest, lookahead, slippage, spread, PnL, short, stop and paper trading are the words a
 * Brazilian who trades actually uses. Rendering them as "rebaixamento" or "fator de lucro" would
 * read as a machine translation of a domain nobody consulted, which is worse than leaving the page
 * in English. So the chrome, the prose and the instructions move; the vocabulary stays.
 *
 * The generated report stays in English entirely. It is `renderHtmlReport`'s output, a published
 * artefact of the package, and the file people attach to a pull request should read the same
 * wherever it is opened. Only the site chrome around it translates.
 *
 * Keys are `data-i18n` attributes in the markup. A key with no entry renders its English original
 * rather than a placeholder, so a missed string is merely untranslated rather than broken.
 */

export type Lang = 'en' | 'pt';

const STORAGE_KEY = 'tapedeck.lang';

/** Portuguese only. English is whatever the markup already says, so it cannot fall out of date. */
const PT: Readonly<Record<string, string>> = {
  // ------------------------------------------------------------------ shared chrome
  'nav.demo': 'Demo',
  'nav.report': 'Report',
  'nav.bench': 'Benchmark',
  'nav.api': 'API',
  'nav.github': 'GitHub',
  'nav.home': 'Início',
  'foot.apiGuide': 'Guia da API',
  'foot.adrs': 'Decisões de arquitetura',
  'foot.source': 'Código-fonte',
  'foot.builtBy': 'Feito por',

  // -------------------------------------------------------------------- landing page
  'home.eyebrow': 'Motor de backtest · TypeScript',
  'home.title': 'Backtests que não sabem te bajular.',
  'home.lede':
    'Um motor de backtest e paper trading orientado a eventos, em TypeScript. Sem lookahead, dinheiro em inteiros de ponto fixo, e toda suposição que a execução precisou fazer impressa acima do resultado, não embaixo dele.',
  'home.cta.demo': 'Rode um backtest no navegador',
  'home.cta.report': 'Veja um report completo',
  'home.note':
    '8.760 candles de 1h são reprocessados em cerca de 50 ms, na sua aba, no mesmo kernel que a linha de comando roda. Nada sai do seu navegador.',
  'home.caption':
    'As ressalvas são impressas <strong>acima</strong> do resultado. No terminal, no report e neste site, sempre. O motor que sabe o que não conseguiu modelar e esconde é o que bajula.',
  'stat.tests': 'testes',
  'stat.coverage': 'cobertura',
  'stat.adrs': 'decisões registradas',
  'stat.deps': 'deps de runtime no core',

  'home.why.eyebrow': 'Por que existe',
  'home.why.title': 'Três formas de um backtester mentir',
  'home.why.lede':
    'As três são estruturais, não acidentais. O Tapedeck é construído de modo que nenhuma delas seja sequer expressável.',
  'home.lie1.title': 'Ele age sobre o que não sabia',
  'home.lie1.body':
    'Um candle chega, a estratégia lê o fechamento dele, e o motor executa a ordem resultante nesse mesmo fechamento.',
  'home.lie1.fix':
    'Uma ordem enviada durante o processamento de um candle nunca executa contra esse candle.',
  'home.lie2.title': 'Ele desempata a seu favor',
  'home.lie2.body':
    'Quando um stop e um alvo cabem os dois dentro do range de um candle, o motor escolhe um em silêncio, e raramente é o stop.',
  'home.lie2.fix':
    'O ramo pessimista vence, e o candle é contado em <code>stats.ambiguousBars</code>.',
  'home.lie3.title': 'Ele guarda dinheiro em ponto flutuante',
  'home.lie3.body':
    'Ao longo de algumas centenas de milhares de execuções, o PnL reportado deixa de bater com a soma dos trades.',
  'home.lie3.fix':
    'Inteiros de ponto fixo de ponta a ponta, com custo de aquisição em vez de preço médio.',

  'home.costs.eyebrow': 'O que isso te dá',
  'home.costs.lede':
    'Um cruzamento de médias móveis 24/72 sobre um ano de BTCUSDT em 1h, com as taxas reais da Binance.',
  'home.costs.gross': 'PnL antes dos custos, USDT',
  'home.costs.fees': 'taxas pagas, USDT',
  'home.costs.net': 'lucro líquido, USDT',
  'home.costs.note':
    'Um backtester que ignorasse as taxas teria reportado uma estratégia três vezes e meia melhor do que a que existe. <a href="demo/">Coloque os custos em nenhum na demo</a> e veja acontecer.',

  'home.live.eyebrow': 'Paper trading',
  'home.live.title': 'A mesma estratégia, ao vivo',
  'home.live.lede':
    'Uma estratégia roda inalterada em backtest e em paper trading contra o feed ao vivo da exchange. Não é camada de compatibilidade: os dois modos compartilham um único kernel síncrono, e a única diferença real é quem alimenta a fila de eventos, um arquivo ou um socket.',

  // ----------------------------------------------------------------------- demo page
  'demo.eyebrow': 'Demo ao vivo',
  'demo.title': 'O motor, rodando no seu navegador',
  'demo.lede':
    'Escolha um mercado, mude qualquer parâmetro, e o backtest roda de novo nesta aba, no mesmo kernel determinístico que a linha de comando usa. Nada é enviado para lugar nenhum, a página reprocessa localmente um ano de dados reais da Binance.',
  'demo.loading': 'carregando o tape…',
  'demo.source': 'candles de 1h · os mesmos arquivos que a suíte de testes lê',
  'demo.replayed': 'candles reprocessados em',
  'demo.rate': 'candles/s',
  'demo.inTab': 'nesta aba, no mesmo kernel que a linha de comando roda.',
  'demo.subTick': 'menos que a resolução do relógio',

  'field.fast': 'média rápida',
  'field.slow': 'média lenta',
  'field.size': 'tamanho da posição (USDT)',
  'field.costs': 'custos',
  'field.short': 'permitir shorts',
  'field.run': 'Rodar',
  'costs.binance': 'Binance spot, 10 bps + slippage',
  'costs.ideal': 'nenhum, o cenário bajulador',

  'help.fast':
    'Candles na média móvel curta. Ela reage antes, então cruza mais vezes e paga mais taxa.',
  'help.slow':
    'Candles na média móvel longa. O cruzamento das duas é o sinal inteiro: rápida acima da lenta é comprado, abaixo é vendido.',
  'help.size':
    'Quanto manter por sinal, na moeda de cotação. Em USDT e não em moeda-base para que os cinco mercados sejam comparáveis; a quantidade em moeda é derivada por instrumento e aparece abaixo.',
  'help.costs':
    'Binance spot aplica a taxa de taker publicada pela corretora, 10 bps, mais slippage. Colocar em nenhum é a configuração bajuladora que a maioria dos backtesters entrega por padrão.',
  'help.short':
    'Ligado, um cruzamento de baixa abre um short. Desligado, ele apenas zera a posição, que é o que uma conta spot sem margem consegue de fato fazer.',

  'demo.hint':
    'Toda mudança roda o backtest de novo. O capital inicial é de 100.000&nbsp;USDT, e os padrões são a configuração exata por trás do <a href="../report/">report publicado</a>.',

  'warn.title': 'O que esta execução não podia saber',
  'chart.equity': 'Equity',
  'chart.drawdown': 'Drawdown',
  'chart.hover': 'passe o mouse para ler a data',

  'metric.netProfit': 'lucro líquido',
  'metric.totalReturn': 'retorno total',
  'metric.maxDrawdown': 'drawdown máximo',
  'metric.sharpe': 'Sharpe',
  'metric.trades': 'trades',
  'metric.winRate': 'win rate',
  'metric.profitFactor': 'profit factor',
  'metric.commission': 'taxas',
  'metric.costsAte': 'custos comeram',

  'helpm.netProfit':
    'PnL realizado e não realizado depois de toda taxa e todo slippage que a execução aplicou.',
  'helpm.totalReturn': 'Lucro líquido sobre o capital inicial de 100.000 USDT. Não anualizado.',
  'helpm.maxDrawdown':
    'A maior queda de pico a fundo no equity, como fração do pico. O que segurar isso teria parecido no pior momento.',
  'helpm.sharpe':
    'Retorno médio sobre o desvio padrão, anualizado a partir do intervalo do candle. Pune volatilidade para cima com a mesma severidade que para baixo.',
  'helpm.trades':
    'Operações fechadas, com ganhos e perdas. Qualquer posição ainda aberta no fim é zerada antes, então nada fica sem preço.',
  'helpm.winRate':
    'Fração dos trades fechados que deram lucro. Sozinha não diz quase nada. Seguir tendência acerta pouco e acerta grande.',
  'helpm.profitFactor':
    'Lucro bruto dividido pela perda bruta. Abaixo de 1,0 a estratégia perde dinheiro; 1,07 significa que ela mal se pagou.',
  'helpm.commission':
    'Total de taxas cobradas, nas alíquotas de maker e taker publicadas pela corretora.',
  'helpm.costsAte':
    'Taxas como fração do lucro bruto. É o número que um backtester que ignora custos nunca precisa te mostrar.',

  'action.share': 'Copiar link desta execução',
  'action.shareCopied': 'Link copiado.',
  'action.shareNote':
    'A barra de endereços já carrega esta configuração. Quem abrir recalcula os mesmos números, sem conta e sem nada guardado.',
  'demo.more.cta': 'Abrir o report completo desta execução',
  'demo.more.note':
    'Lista de trades, abertura dos custos e parâmetros da execução, gerados pela mesma função que a linha de comando chama. O link carrega a configuração, então ele abre nesta execução e pode ser compartilhado.',

  'demo.try.eyebrow': 'Vale testar',
  'demo.try.title': 'De onde vem o resultado',
  'demo.try1.title': 'Coloque os custos em nenhum',
  'demo.try1.body':
    'O resultado praticamente quadruplica. Essa diferença é o argumento inteiro: um backtester que ignora taxas reporta uma estratégia que não existe.',
  'demo.try2.title': 'Procure um período melhor',
  'demo.try2.body':
    'Numa grade 5×5 deles, treze de dezenove perdem dinheiro, e nenhum termina com mais ganhos que perdas.',
  'demo.try3.title': 'Leia o profit factor',
  'demo.try3.body':
    'Um win rate de 36% é a cara de seguir tendência: muitas perdas pequenas pagando algumas poucas vitórias grandes. O win rate não é o número a ler.',
  'demo.foot':
    'não tem nenhuma dependência de runtime e não importa nada de `node:`. Essa regra foi feita por reprodutibilidade, não por portabilidade; rodar no navegador saiu dela de graça.',

  // ---------------------------------------------------------------------- entry page

  // --------------------------------------------------------------------- report page
  'report.example':
    'O exemplo publicado: um cruzamento 24/72 sobre um ano de BTCUSDT em 1h, regerado a partir do fixture versionado a cada deploy.',
  'report.runYours': 'Rode o seu →',
  'report.recomputing': 'Recalculando…',
  'report.yours': 'Sua execução.',
  'report.yoursTail':
    'Recalculado nesta aba a partir do mesmo kernel e do mesmo tape, então estes são os números da demo até o centavo.',
  'report.download': 'Baixar',
  'report.back': 'Voltar para a demo',
  'report.failed': 'Não foi possível calcular essa execução:',
};

let current: Lang = 'en';

/** The reader's choice, then the browser's, then English. */
export function initialLang(): Lang {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'pt' || stored === 'en') return stored;
  return navigator.language.toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

export const lang = (): Lang => current;

/** A translated string, or the English fallback the caller supplies. */
export function t(key: string, english: string): string {
  if (current === 'en') return english;
  return PT[key] ?? english;
}

/**
 * Applies a language to the markup.
 *
 * The English text lives in the HTML and is captured on the first pass, so switching back needs no
 * second dictionary and the two can never disagree. `data-i18n` replaces `innerHTML` because
 * several strings wrap a `<code>` or a link; `data-i18n-*` handles attributes.
 */
export function apply(next: Lang): void {
  current = next;
  document.documentElement.lang = next === 'pt' ? 'pt-BR' : 'en';
  window.localStorage.setItem(STORAGE_KEY, next);

  for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    const key = node.dataset['i18n'];
    if (key === undefined) continue;
    if (node.dataset['en'] === undefined) node.dataset['en'] = node.innerHTML;
    node.innerHTML = next === 'pt' ? (PT[key] ?? node.dataset['en']) : node.dataset['en'];
  }

  for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-i18n-attr]'))) {
    const spec = node.dataset['i18nAttr'];
    if (spec === undefined) continue;
    for (const pair of spec.split(',')) {
      const [attr, key] = pair.split(':');
      if (attr === undefined || key === undefined) continue;
      const memo = `en${attr.replace(/[^a-z]/gi, '')}`;
      if (node.dataset[memo] === undefined) node.dataset[memo] = node.getAttribute(attr) ?? '';
      const english = node.dataset[memo] ?? '';
      node.setAttribute(attr, next === 'pt' ? (PT[key] ?? english) : english);
    }
  }

  for (const button of Array.from(document.querySelectorAll<HTMLElement>('[data-lang]'))) {
    button.setAttribute('aria-pressed', button.dataset['lang'] === next ? 'true' : 'false');
  }
}

/**
 * Wires the toggle and applies the starting language.
 *
 * `rerender` exists because half of each page is built by script: switching language has to redraw
 * the metric cards and the charts, not just swap the static copy around them.
 */
export function setup(rerender: () => void): void {
  apply(initialLang());
  for (const button of Array.from(document.querySelectorAll<HTMLElement>('[data-lang]'))) {
    button.addEventListener('click', () => {
      const next = button.dataset['lang'];
      if (next !== 'pt' && next !== 'en') return;
      if (next === current) return;
      apply(next);
      rerender();
    });
  }
}
