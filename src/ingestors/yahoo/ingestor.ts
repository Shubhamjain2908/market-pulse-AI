/**
 * Yahoo Finance ingestor. Workhorse for the 200-day historical OHLCV
 * window the technical enricher needs. Uses the official yahoo-finance2
 * client which handles its own auth/cookies, so we don't need our own
 * HTTP client here.
 *
 * Symbols are mapped to Yahoo's '<SYMBOL>.NS' suffix for NSE listings.
 * BSE is '<SYMBOL>.BO' but we focus on NSE in Phase 1.
 */

import YahooFinance from 'yahoo-finance2';
import { child } from '../../logger.js';
import { toYahooFinanceTicker } from '../../market/yahoo-ticker.js';
import type { RawQuote } from '../../types/domain.js';
import { isoDateIst } from '../base/dates.js';
import type { IngestResult, Ingestor, IngestorCapability, IngestorContext } from '../types.js';

const log = child({ component: 'yahoo-ingestor' });
const DEFAULT_LOOKBACK_DAYS = 260; // ~52 trading weeks plus a buffer

export interface YahooIngestorOptions {
  /** How many calendar days of history to fetch. Default ~260. */
  lookbackDays?: number;
}

export class YahooIngestor implements Ingestor {
  readonly name = 'yahoo';
  readonly capabilities: ReadonlySet<IngestorCapability> = new Set(['quotes']);

  private readonly lookbackDays: number;
  private readonly client: InstanceType<typeof YahooFinance>;

  constructor(opts: YahooIngestorOptions = {}) {
    this.lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    this.client = new YahooFinance();
  }

  async fetchQuotes(ctx: IngestorContext = {}): Promise<IngestResult<RawQuote>> {
    const symbols = ctx.symbols ?? [];
    const today = ctx.date ?? isoDateIst();
    const period2 = new Date(`${today}T23:59:59+05:30`);
    const period1 = new Date(period2.getTime() - this.lookbackDays * 24 * 60 * 60 * 1000);

    const all: RawQuote[] = [];
    const failed: string[] = [];

    for (const symbol of symbols) {
      try {
        const ticker = toYahooFinanceTicker(symbol);
        const rows = await this.client.chart(ticker, {
          period1,
          period2,
          interval: '1d',
        });
        for (const q of rows.quotes ?? []) {
          if (q.open == null || q.high == null || q.low == null || q.close == null) continue;
          all.push({
            symbol: symbol.toUpperCase(),
            exchange: 'NSE',
            date: q.date.toISOString().slice(0, 10),
            open: q.open,
            high: q.high,
            low: q.low,
            close: q.close,
            adjClose: q.adjclose ?? undefined,
            volume: q.volume ?? 0,
            source: this.name,
          });
        }
      } catch (err) {
        log.warn({ symbol, err: (err as Error).message }, 'yahoo quote fetch failed');
        failed.push(symbol);
      }
    }
    return { data: all, failed, source: this.name };
  }
}
