/**
 * Curated RSS feed list. All feeds here are public and free. Add new ones
 * as you find them - keep `marketWide: true` for general market news and
 * `false` for company-specific feeds we plan to symbol-tag later.
 */

export interface FeedDefinition {
  /** Stable id used in `news.source`. */
  id: string;
  /** Human-readable name shown in the briefing. */
  label: string;
  url: string;
  /** True when the feed mixes many companies/topics (no per-symbol mapping). */
  marketWide: boolean;
}

export const DEFAULT_FEEDS: FeedDefinition[] = [
  {
    id: 'et-markets',
    label: 'ET Markets',
    url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
    marketWide: true,
  },
  {
    id: 'et-stocks',
    label: 'ET Stocks',
    url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms',
    marketWide: true,
  },
  {
    id: 'moneycontrol-markets',
    label: 'Moneycontrol Markets',
    url: 'https://www.moneycontrol.com/rss/marketreports.xml',
    marketWide: true,
  },
  {
    id: 'moneycontrol-results',
    label: 'Moneycontrol Results',
    url: 'https://www.moneycontrol.com/rss/results.xml',
    marketWide: true,
  },
  {
    id: 'moneycontrol-business',
    label: 'Moneycontrol Business',
    url: 'https://www.moneycontrol.com/rss/business.xml',
    marketWide: true,
  },
];
