/**
 * Screener.in fundamentals scraper. Pulls /company/<SYMBOL>/consolidated/
 * for each watchlist symbol, parses the ratios block with cheerio, and
 * writes a Fundamentals row. Quarterly fundamentals (revenue, OPM, EPS, FCF)
 * are parsed from the same HTML page and returned via the result's
 * `quarterlyData` field — zero additional HTTP requests.
 *
 * Screener is rate-friendly but their HTML changes from time to time.
 * Failures are non-fatal - we surface them in `failed[]` and let the
 * pipeline continue.
 */

import { RATE_LIMITS } from '../../constants.js';
import { child } from '../../logger.js';
import { skipScreenerFundamentalsFetch } from '../../market/screener-symbol-skip.js';
import type { Fundamentals, QuarterlyFundamentals } from '../../types/domain.js';
import { createHttpClient, type HttpClient } from '../base/http-client.js';
import type { Ingestor, IngestorCapability, IngestorContext, IngestResult } from '../types.js';
import {
  parseCashFlowFundamentals,
  parseQuarterlyFundamentals,
  parseScreenerHtml,
} from './parser.js';

const log = child({ component: 'screener-ingestor' });
const SCREENER_BASE = 'https://www.screener.in';

function getHttpStatusCode(err: unknown): number {
  const e = err as { response?: { statusCode?: number } };
  return e.response?.statusCode ?? 0;
}

/**
 * Screener URLs use the base company code; some NSE symbols include a
 * trading-series suffix (`-BE`, `-BZ`, ...). Try both forms.
 */
export function buildScreenerCompanyPaths(symbol: string): string[] {
  const u = symbol.trim().toUpperCase();
  const variants = [u];
  const withoutSeries = u.replace(/-[A-Z]{2}$/, '');
  if (withoutSeries !== u && withoutSeries.length > 0) variants.push(withoutSeries);

  const paths: string[] = [];
  for (const v of variants) {
    paths.push(`/company/${encodeURIComponent(v)}/consolidated/`);
    paths.push(`/company/${encodeURIComponent(v)}/`);
  }
  return paths;
}

export class ScreenerIngestor implements Ingestor {
  readonly name = 'screener';
  readonly capabilities: ReadonlySet<IngestorCapability> = new Set(['fundamentals']);

  private readonly client: HttpClient;

  constructor(client?: HttpClient) {
    this.client =
      client ??
      createHttpClient({
        name: 'screener',
        rateLimit: { requestsPerSecond: RATE_LIMITS.screener, burst: 2 },
      });
  }

  async fetchFundamentals(ctx: IngestorContext = {}): Promise<IngestResult<Fundamentals>> {
    const symbols = ctx.symbols ?? [];
    const data: Fundamentals[] = [];
    const quarterlyData: QuarterlyFundamentals[] = [];
    const failed: string[] = [];

    for (const symbol of symbols) {
      if (ctx.signal?.aborted) break;
      if (skipScreenerFundamentalsFetch(symbol)) {
        log.debug({ symbol }, 'screener skip: not listed on screener.in (SGB / index / macro)');
        continue;
      }
      try {
        const html = await this.fetchPage(symbol, ctx.signal);
        const parsed = parseScreenerHtml(html, { symbol, source: this.name, asOf: ctx.date });
        if (parsed) data.push(parsed);

        // Parse quarterly + cash-flow tables from the same HTML (no extra HTTP).
        const quarterly = parseQuarterlyFundamentals(html, {
          symbol,
          source: this.name,
          asOf: ctx.date,
        });
        const cashFlow = parseCashFlowFundamentals(html, {
          symbol,
          source: this.name,
          asOf: ctx.date,
        });

        // Merge cash-flow fields into quarterly rows by matching quarter_end.
        // The database upsert uses COALESCE, so rows from subsequent symbols
        // won't overwrite existing data — this merge is just for this symbol's data.
        const qMap = new Map<string, QuarterlyFundamentals>();
        for (const q of quarterly) qMap.set(q.quarterEnd, { ...q });
        for (const cf of cashFlow) {
          const existing = qMap.get(cf.quarterEnd);
          if (existing) {
            existing.operatingCashFlow = cf.operatingCashFlow;
            existing.freeCashFlow = cf.freeCashFlow;
          } else {
            qMap.set(cf.quarterEnd, { ...cf });
          }
        }
        for (const row of qMap.values()) quarterlyData.push(row);

        if (!parsed) {
          log.warn({ symbol }, 'screener parse returned no ratios');
          failed.push(symbol);
        }
      } catch (err) {
        if (getHttpStatusCode(err) === 404) {
          log.debug({ symbol }, 'screener skip: symbol has no screener.in company page');
          continue;
        }
        log.warn({ symbol, err: (err as Error).message }, 'screener fetch failed');
        failed.push(symbol);
      }
    }
    return { data, quarterlyData, failed, source: this.name };
  }

  private async fetchPage(symbol: string, signal?: AbortSignal): Promise<string> {
    await this.client.acquire(signal);
    // Try consolidated first (preferred for groups), then standalone.
    const paths = buildScreenerCompanyPaths(symbol);
    let lastErr: unknown;
    for (const path of paths) {
      try {
        const res = await this.client.got(`${SCREENER_BASE}${path}`, { signal });
        return res.body;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('screener fetch failed');
  }
}
