/**
 * Every tape the site ships, written down once.
 *
 * This list used to exist twice — `MARKETS` for the picker and `TAPES` in `demo/build.ts` for the
 * copy step — and the two could disagree, which is a 404 the visitor finds. It has no imports on
 * purpose: `scripts/fetch-fixtures.ts` runs under plain Node with no bundler aliases, and it needs
 * the same list to know what to download.
 *
 * A market is identified by `venue-symbol` rather than by the symbol alone. BTC on Binance and BTC
 * on Coinbase are different prices, different fees and different books; collapsing them into
 * "BTC" would be the first lie the page tells.
 */

export type VenueId = 'binance' | 'coinbase';

export interface Venue {
  readonly id: VenueId;
  /** What the picker and the report call it. */
  readonly label: string;
  /** The cost preset a market on this venue opens with — always the venue's own schedule. */
  readonly defaultPreset: string;
  /** Presets that describe this venue. Others exist, and belong to somebody else's fills. */
  readonly presets: readonly string[];
}

/**
 * The venues, and which cost presets belong to each.
 *
 * The pairing is the point. A Coinbase tape priced with Binance's fees is a report about a market
 * nobody traded in, so the page will not let the two meet: switching venue moves the cost setting
 * with it. `ideal` and `stress` are venue-neutral by construction — one charges nothing and the
 * other is explicitly a what-if — so they stay available everywhere.
 */
export const VENUES: Readonly<Record<VenueId, Venue>> = {
  binance: {
    id: 'binance',
    label: 'Binance',
    defaultPreset: 'binanceSpot',
    presets: ['binanceSpot', 'binanceSpotBnb'],
  },
  coinbase: {
    id: 'coinbase',
    label: 'Coinbase',
    defaultPreset: 'coinbaseExchange',
    presets: ['coinbaseExchange'],
  },
};

export interface Market {
  /** `venue-symbol`. Reaches the URL, so it is stable and shareable. */
  readonly id: string;
  readonly venue: VenueId;
  /** The venue's own symbol, as its API spells it. */
  readonly symbol: string;
  readonly name: string;
  /** Base asset, for sizing labels. */
  readonly ticker: string;
  /** Quote currency, which is what a position is sized in. */
  readonly quote: string;
}

/**
 * The instruments the demo offers.
 *
 * Nine Binance pairs and three Coinbase products, all liquid across the whole window so no tape
 * has a gap to explain. They differ enough in price and lot size to be worth switching between:
 * a strategy that looks like an edge on one of them rarely survives the next, which is most of
 * what a picker with twelve entries is for.
 *
 * The three Coinbase products deliberately duplicate assets Binance also lists. Same asset, same
 * year, different venue — the cleanest way to see that a result is a claim about a venue and not
 * about a coin.
 */
export const MARKETS: readonly Market[] = [
  {
    id: 'binance-BTCUSDT',
    venue: 'binance',
    symbol: 'BTCUSDT',
    name: 'Bitcoin',
    ticker: 'BTC',
    quote: 'USDT',
  },
  {
    id: 'binance-ETHUSDT',
    venue: 'binance',
    symbol: 'ETHUSDT',
    name: 'Ethereum',
    ticker: 'ETH',
    quote: 'USDT',
  },
  {
    id: 'binance-SOLUSDT',
    venue: 'binance',
    symbol: 'SOLUSDT',
    name: 'Solana',
    ticker: 'SOL',
    quote: 'USDT',
  },
  {
    id: 'binance-BNBUSDT',
    venue: 'binance',
    symbol: 'BNBUSDT',
    name: 'BNB',
    ticker: 'BNB',
    quote: 'USDT',
  },
  {
    id: 'binance-XRPUSDT',
    venue: 'binance',
    symbol: 'XRPUSDT',
    name: 'XRP',
    ticker: 'XRP',
    quote: 'USDT',
  },
  {
    id: 'binance-DOGEUSDT',
    venue: 'binance',
    symbol: 'DOGEUSDT',
    name: 'Dogecoin',
    ticker: 'DOGE',
    quote: 'USDT',
  },
  {
    id: 'binance-ADAUSDT',
    venue: 'binance',
    symbol: 'ADAUSDT',
    name: 'Cardano',
    ticker: 'ADA',
    quote: 'USDT',
  },
  {
    id: 'binance-LINKUSDT',
    venue: 'binance',
    symbol: 'LINKUSDT',
    name: 'Chainlink',
    ticker: 'LINK',
    quote: 'USDT',
  },
  {
    id: 'binance-AVAXUSDT',
    venue: 'binance',
    symbol: 'AVAXUSDT',
    name: 'Avalanche',
    ticker: 'AVAX',
    quote: 'USDT',
  },
  {
    id: 'coinbase-BTC-USD',
    venue: 'coinbase',
    symbol: 'BTC-USD',
    name: 'Bitcoin',
    ticker: 'BTC',
    quote: 'USD',
  },
  {
    id: 'coinbase-ETH-USD',
    venue: 'coinbase',
    symbol: 'ETH-USD',
    name: 'Ethereum',
    ticker: 'ETH',
    quote: 'USD',
  },
  {
    id: 'coinbase-SOL-USD',
    venue: 'coinbase',
    symbol: 'SOL-USD',
    name: 'Solana',
    ticker: 'SOL',
    quote: 'USD',
  },
];

/** What `scripts/fetch-fixtures.ts` downloads and `demo/build.ts` copies. Same list, less of it. */
export const TAPES: readonly {
  readonly id: string;
  readonly venue: VenueId;
  readonly symbol: string;
}[] = MARKETS.map((market) => ({ id: market.id, venue: market.venue, symbol: market.symbol }));

/**
 * Links shared before the second venue existed carry `symbol=BTCUSDT`, with no venue in it.
 *
 * They resolve to the Binance market they always meant. This is an alias, not a repair: the run it
 * opens is the run that was shared, which is the only reason it is allowed at all.
 */
export function marketById(id: string): Market | undefined {
  return (
    MARKETS.find((market) => market.id === id) ??
    MARKETS.find((market) => market.venue === 'binance' && market.symbol === id)
  );
}
