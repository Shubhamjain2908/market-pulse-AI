/**
 * RSS news ingestor. Pulls recent items from a curated feed list (ET,
 * Moneycontrol) and best-effort tags them with a stock symbol when the
 * headline mentions a watchlist member.
 *
 * Feeds are fetched via our shared `got`-based HttpClient (rate-limited,
 * per-feed UA overrides) and then parsed with rss-parser's
 * `parseString()`. This is more reliable than rss-parser's built-in
 * `parseURL()`, which doesn't expose enough request control to bypass
 * Moneycontrol's UA-based WAF rules.
 *
 * Sentiment is left null — that's the sentiment enricher's job.
 */

import Parser from 'rss-parser';
import { RATE_LIMITS } from '../../constants.js';
import { child } from '../../logger.js';
import type { NewsItem } from '../../types/domain.js';
import { type HttpClient, createHttpClient } from '../base/http-client.js';
import type { IngestResult, Ingestor, IngestorCapability, IngestorContext } from '../types.js';
import { DEFAULT_FEEDS, type FeedDefinition } from './feeds.js';

const log = child({ component: 'rss-ingestor' });

export interface RssIngestorOptions {
  feeds?: FeedDefinition[];
  /** Only return items younger than this many hours. Default 48h. */
  maxAgeHours?: number;
  /** Inject a pre-built http client (tests). */
  httpClient?: HttpClient;
}

export class RssNewsIngestor implements Ingestor {
  readonly name = 'rss-news';
  readonly capabilities: ReadonlySet<IngestorCapability> = new Set(['news']);

  private readonly feeds: FeedDefinition[];
  private readonly maxAgeMs: number;
  private readonly parser: Parser;
  private readonly client: HttpClient;

  constructor(opts: RssIngestorOptions = {}) {
    this.feeds = opts.feeds ?? DEFAULT_FEEDS;
    this.maxAgeMs = (opts.maxAgeHours ?? 48) * 60 * 60 * 1000;
    this.parser = new Parser({ timeout: 15_000 });
    this.client =
      opts.httpClient ??
      createHttpClient({
        name: 'rss',
        rateLimit: { requestsPerSecond: RATE_LIMITS.rss, burst: 2 },
      });
  }

  async fetchNews(ctx: IngestorContext = {}): Promise<IngestResult<NewsItem>> {
    const all: NewsItem[] = [];
    const failed: string[] = [];
    const cutoff = Date.now() - this.maxAgeMs;
    const watchlist = (ctx.symbols ?? []).map((s) => s.toUpperCase());

    for (const feed of this.feeds) {
      if (ctx.signal?.aborted) break;
      try {
        const xml = await this.fetchFeedXml(feed, ctx.signal);
        const parsed = await this.parser.parseString(xml);
        for (const item of parsed.items ?? []) {
          if (!item.title || !item.link) continue;
          const publishedAt = item.isoDate ?? item.pubDate ?? null;
          const ts = publishedAt ? Date.parse(publishedAt) : Date.now();
          if (Number.isFinite(ts) && ts < cutoff) continue;

          all.push({
            symbol: tagSymbol(item.title, watchlist),
            headline: item.title.trim(),
            summary: stripHtml(item.contentSnippet ?? item.content ?? '').slice(0, 500),
            source: feed.id,
            url: item.link,
            publishedAt: new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString(),
          });
        }
      } catch (err) {
        log.warn({ feed: feed.id, err: (err as Error).message }, 'rss feed fetch failed');
        failed.push(feed.id);
      }
    }
    return { data: all, failed, source: this.name };
  }

  private async fetchFeedXml(feed: FeedDefinition, signal?: AbortSignal): Promise<string> {
    await this.client.acquire(signal);
    const headers: Record<string, string> = {
      accept: 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5',
    };
    if (feed.userAgent) headers['user-agent'] = feed.userAgent;
    const res = await this.client.got(feed.url, {
      headers,
      timeout: { request: 15_000 },
      signal,
    });
    return res.body;
  }
}

/** Best-effort: pick the first watchlist symbol whose token appears in the headline. */
function tagSymbol(headline: string, watchlist: string[]): string | undefined {
  if (watchlist.length === 0) return undefined;
  const upper = headline.toUpperCase();
  for (const sym of watchlist) {
    if (new RegExp(`\\b${sym}\\b`).test(upper)) return sym;
  }
  return undefined;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
