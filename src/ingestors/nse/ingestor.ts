/**
 * NSE EOD ingestor. Provides:
 *   - fetchQuotes: today's OHLCV per symbol via /api/quote-equity
 *   - fetchFiiDii: cash-segment FII/DII totals via /api/fiidiiTradeReact
 *
 * Note: NSE's per-symbol endpoint is rate-limited and brittle. For bulk
 * historical coverage (the 200-day window the enricher needs), prefer the
 * YahooIngestor. NseIngestor is the authoritative source for "today" and
 * for FII/DII activity, which Yahoo doesn't carry.
 *
 * Headers strategy: the underlying HttpClient is configured with browser-y
 * defaults (UA, accept-language). The XHR-style headers (referer, origin,
 * x-requested-with) are added per-request only when calling /api/* — never
 * during cookie priming, since Akamai uses them as a bot signal.
 */

import { z } from 'zod';
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

/** Headers to add ONLY on /api/* requests — never on the cookie prime. */
const API_HEADERS = {
  accept: '*/*',
  referer: 'https://www.nseindia.com/',
  origin: 'https://www.nseindia.com',
  'x-requested-with': 'XMLHttpRequest',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
} as const;

/** Per-page referer overrides — hints to NSE which dashboard "owns" the call. */
const FII_DII_REFERER = 'https://www.nseindia.com/reports/fii-dii';

const NseFiiDiiRowSchema = z.object({
  category: z.string(),
  date: z.string(),
  buyValue: z.union([z.string(), z.number()]),
  sellValue: z.union([z.string(), z.number()]),
  netValue: z.union([z.string(), z.number()]),
});
const NseFiiDiiResponseSchema = z.array(NseFiiDiiRowSchema);

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
        // Intentionally no XHR-style defaults here — those are added
        // per-request by `apiHeaders()` to avoid breaking the cookie prime.
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
        if (this.shouldReprime(err)) this.cookiesPrimed = false;
      }
    }
    return { data: quotes, failed, source: this.name };
  }

  async fetchFiiDii(ctx: IngestorContext = {}): Promise<IngestResult<FiiDiiRow>> {
    await this.ensurePrimed(ctx.signal);
    try {
      const raw = await this.client.request<unknown>(`${NSE_API}/fiidiiTradeReact`, {
        signal: ctx.signal,
        headers: { ...API_HEADERS, referer: FII_DII_REFERER },
      });
      const parsed = NseFiiDiiResponseSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn(
          { issues: parsed.error.issues.slice(0, 3), preview: JSON.stringify(raw).slice(0, 300) },
          'nse fii/dii response failed validation',
        );
        return { data: [], failed: ['fii_dii'], source: this.name };
      }
      const merged = this.mergeFiiDii(parsed.data);
      return { data: merged, failed: [], source: this.name };
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'nse fii/dii fetch failed');
      if (this.shouldReprime(err)) this.cookiesPrimed = false;
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
    return this.client.request<NseQuoteResponse>(url, { signal, headers: API_HEADERS });
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

  /**
   * The endpoint returns one row per category (FII/FPI and DII) for the
   * same date. We collapse them into a single FiiDiiRow per (date, segment)
   * — otherwise the second insert would overwrite the first via the
   * `(date, segment)` primary key.
   */
  private mergeFiiDii(rows: NseFiiDiiRow[]): FiiDiiRow[] {
    const byDate = new Map<string, FiiDiiRow>();
    for (const row of rows) {
      const date = parseNseDate(row.date) ?? isoDateIst();
      const isFii = row.category.startsWith('FII');
      const buy = Number(row.buyValue);
      const sell = Number(row.sellValue);
      const net = Number(row.netValue);
      if (!Number.isFinite(buy) || !Number.isFinite(sell) || !Number.isFinite(net)) continue;

      const existing = byDate.get(date) ?? {
        date,
        segment: 'cash' as const,
        fiiBuy: 0,
        fiiSell: 0,
        fiiNet: 0,
        diiBuy: 0,
        diiSell: 0,
        diiNet: 0,
        source: this.name,
      };
      if (isFii) {
        existing.fiiBuy = buy;
        existing.fiiSell = sell;
        existing.fiiNet = net;
      } else {
        existing.diiBuy = buy;
        existing.diiSell = sell;
        existing.diiNet = net;
      }
      byDate.set(date, existing);
    }
    return [...byDate.values()];
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
