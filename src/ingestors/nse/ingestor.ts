/**
 * NSE EOD ingestor. Provides:
 *   - fetchQuotes: today's OHLCV per symbol via /api/quote-equity
 *   - fetchFiiDii: cash-segment FII/DII totals via /api/fiidiiTradeReact
 *
 * Note: NSE's per-symbol endpoint is rate-limited and brittle. For bulk
 * historical coverage (the 200-day window the enricher needs), prefer the
 * YahooIngestor. NseIngestor is the authoritative source for "today" and
 * for FII/DII activity, which Yahoo doesn't carry.
 */

import { RATE_LIMITS } from '../../constants.js';
import { child } from '../../logger.js';
import type { FiiDiiRow, RawQuote } from '../../types/domain.js';
import { isoDateIst } from '../base/dates.js';
import { type HttpClient, createHttpClient } from '../base/http-client.js';
import type { IngestResult, Ingestor, IngestorCapability, IngestorContext } from '../types.js';
import { primeNseCookies } from './cookie-jar.js';
import type { NseFiiDiiRow, NseQuoteResponse } from './types.js';

const NSE_API = 'https://www.nseindia.com/api';
const log = child({ component: 'nse-ingestor' });

export class NseIngestor implements Ingestor {
  readonly name = 'nse-eod';
  readonly capabilities: ReadonlySet<IngestorCapability> = new Set(['quotes', 'fii_dii']);

  private readonly client: HttpClient;
  private cookiesPrimed = false;

  constructor(client?: HttpClient) {
    this.client =
      client ??
      createHttpClient({
        name: 'nse',
        rateLimit: { requestsPerSecond: RATE_LIMITS.nse, burst: 4 },
        withCookieJar: true,
        defaults: {
          headers: {
            referer: 'https://www.nseindia.com/',
            origin: 'https://www.nseindia.com',
            'x-requested-with': 'XMLHttpRequest',
          },
        },
      });
  }

  async init(ctx: IngestorContext = {}): Promise<void> {
    await this.ensurePrimed(ctx.signal);
  }

  async fetchQuotes(ctx: IngestorContext = {}): Promise<IngestResult<RawQuote>> {
    await this.ensurePrimed(ctx.signal);
    const symbols = ctx.symbols ?? [];
    const date = ctx.date ?? isoDateIst();
    const quotes: RawQuote[] = [];
    const failed: string[] = [];

    for (const symbol of symbols) {
      try {
        const data = await this.fetchOne(symbol, ctx.signal);
        const mapped = this.mapQuote(symbol, date, data);
        if (mapped) quotes.push(mapped);
        else failed.push(symbol);
      } catch (err) {
        log.warn({ symbol, err: (err as Error).message }, 'nse quote fetch failed');
        failed.push(symbol);
        // Re-prime cookies on auth-style failures - NSE does this often.
        if (this.shouldReprime(err)) this.cookiesPrimed = false;
      }
    }
    return { data: quotes, failed, source: this.name };
  }

  async fetchFiiDii(ctx: IngestorContext = {}): Promise<IngestResult<FiiDiiRow>> {
    await this.ensurePrimed(ctx.signal);
    try {
      const rows = await this.client.request<NseFiiDiiRow[]>(`${NSE_API}/fiidiiTradeReact`, {
        signal: ctx.signal,
      });
      const data = rows.map((r) => this.mapFiiDii(r)).filter((r): r is FiiDiiRow => r !== null);
      return { data, failed: [], source: this.name };
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'nse fii/dii fetch failed');
      return { data: [], failed: ['fii_dii'], source: this.name };
    }
  }

  private async ensurePrimed(signal?: AbortSignal): Promise<void> {
    if (this.cookiesPrimed) return;
    await primeNseCookies(this.client, signal);
    this.cookiesPrimed = true;
  }

  private async fetchOne(symbol: string, signal?: AbortSignal): Promise<NseQuoteResponse> {
    const url = `${NSE_API}/quote-equity?symbol=${encodeURIComponent(symbol.toUpperCase())}`;
    return this.client.request<NseQuoteResponse>(url, { signal });
  }

  private mapQuote(symbol: string, date: string, data: NseQuoteResponse): RawQuote | null {
    const price = data.priceInfo;
    if (!price) return null;
    const high = price.intraDayHighLow?.max ?? price.lastPrice;
    const low = price.intraDayHighLow?.min ?? price.lastPrice;
    const open = price.open ?? price.previousClose;
    const close = price.lastPrice ?? price.close ?? price.previousClose;
    const volume =
      data.preOpenMarket?.totalTradedVolume ?? data.securityWiseDP?.quantityTraded ?? 0;

    if (open == null || high == null || low == null || close == null) return null;

    return {
      symbol: symbol.toUpperCase(),
      exchange: 'NSE',
      date,
      open,
      high,
      low,
      close,
      volume: Math.round(volume),
      source: this.name,
    };
  }

  private mapFiiDii(row: NseFiiDiiRow): FiiDiiRow | null {
    const category = row.category?.trim();
    if (!category) return null;
    // The endpoint returns one row per category - we synthesise a combined
    // row keyed by date+segment so the table primary key holds.
    const isFii = category.startsWith('FII');
    const date = parseNseDate(row.date) ?? isoDateIst();
    return {
      date,
      segment: 'cash',
      fiiBuy: isFii ? row.buyValue : 0,
      fiiSell: isFii ? row.sellValue : 0,
      fiiNet: isFii ? row.netValue : 0,
      diiBuy: isFii ? 0 : row.buyValue,
      diiSell: isFii ? 0 : row.sellValue,
      diiNet: isFii ? 0 : row.netValue,
      source: this.name,
    };
  }

  private shouldReprime(err: unknown): boolean {
    const e = err as { response?: { statusCode?: number } };
    const code = e.response?.statusCode;
    return code === 401 || code === 403;
  }
}

/** NSE returns dates like '30-Apr-2026'. Convert to ISO. */
function parseNseDate(s: string): string | null {
  const m = s?.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  const [, dd, mon, yyyy] = m;
  if (!dd || !mon || !yyyy) return null;
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const monthIdx = months.indexOf(mon);
  if (monthIdx < 0) return null;
  return `${yyyy}-${String(monthIdx + 1).padStart(2, '0')}-${dd.padStart(2, '0')}`;
}
