/**
 * Curated RSS feed list. All feeds here are public and free. Add new ones
 * as you find them — keep `marketWide: true` for general market news and
 * `false` for company-specific feeds we plan to symbol-tag later.
 *
 * `userAgent` overrides the default UA per feed. Moneycontrol's WAF
 * actively blocks Chrome-style UAs (`Mozilla/5.0 ... Chrome/...`), so we
 * use a generic library UA for those endpoints. ET feeds accept either.
 */

export interface FeedDefinition {
  /** Stable id used in `news.source`. */
  id: string;
  /** Human-readable name shown in the briefing. */
  label: string;
  url: string;
  /** True when the feed mixes many companies/topics (no per-symbol mapping). */
  marketWide: boolean;
  /** Optional per-feed UA override. */
  userAgent?: string;
}

/**
 * Generic UA that Moneycontrol's WAF accepts. The `+url` suffix follows
 * RFC 9309-style bot identification convention so site owners can identify
 * the client and reach out if needed.
 */
const POLITE_BOT_UA =
  'Mozilla/5.0 (compatible; MarketPulseAI/1.0; +https://github.com/personal-projects)';

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
    userAgent: POLITE_BOT_UA,
  },
  {
    id: 'moneycontrol-results',
    label: 'Moneycontrol Results',
    url: 'https://www.moneycontrol.com/rss/results.xml',
    marketWide: true,
    userAgent: POLITE_BOT_UA,
  },
  {
    id: 'moneycontrol-business',
    label: 'Moneycontrol Business',
    url: 'https://www.moneycontrol.com/rss/business.xml',
    marketWide: true,
    userAgent: POLITE_BOT_UA,
  },
];
