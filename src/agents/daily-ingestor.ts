/**
 * Daily Ingestor agent. Orchestrates the registered ingestors against the
 * symbol universe (watchlist + latest portfolio holdings + benchmark quotes,
 * or explicit symbols), persists the results to SQLite, and returns a summary.
 *
 * Each capability is wrapped in try/catch so a flaky source can't take the
 * whole run down. Detailed errors are logged but never thrown.
 */

import { config } from '../config/env.js';
import { getDb, insertNews, upsertFiiDii, upsertFundamentals, upsertQuotes } from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import {
  type IngestorCapability,
  type IngestorContext,
  bootstrapIngestors,
  pickIngestor,
} from '../ingestors/index.js';
import { child } from '../logger.js';
import { defaultIngestSymbolUniverse } from '../market/ingest-symbols.js';

const log = child({ component: 'daily-ingestor' });

export interface IngestRunOptions {
  date?: string;
  symbols?: string[];
  signal?: AbortSignal;
}

export interface IngestRunResult {
  date: string;
  symbols: number;
  quotesWritten: number;
  fundamentalsWritten: number;
  newsWritten: number;
  fiiDiiWritten: number;
  failures: { capability: IngestorCapability; ingestor: string; reason: string }[];
}

export async function runDailyIngestor(opts: IngestRunOptions = {}): Promise<IngestRunResult> {
  bootstrapIngestors();

  const date = opts.date ?? isoDateIst();
  const symbols = opts.symbols
    ? opts.symbols.map((s) => s.toUpperCase())
    : defaultIngestSymbolUniverse(getDb());
  const ctx: IngestorContext = { date, symbols, signal: opts.signal };

  const result: IngestRunResult = {
    date,
    symbols: symbols.length,
    quotesWritten: 0,
    fundamentalsWritten: 0,
    newsWritten: 0,
    fiiDiiWritten: 0,
    failures: [],
  };

  // ---- Quotes (Yahoo by default for bulk historical) ----
  const quoteIngestor = pickIngestor('quotes');
  if (quoteIngestor?.fetchQuotes) {
    try {
      await quoteIngestor.init?.(ctx);
      const maxR = config.INGEST_QUOTES_MAX_RETRIES;
      let pending = symbols;
      let totalWritten = 0;
      for (let attempt = 0; attempt <= maxR; attempt++) {
        if (pending.length === 0) break;
        const r = await quoteIngestor.fetchQuotes({ ...ctx, symbols: pending });
        totalWritten += upsertQuotes(r.data);
        if (r.failed.length === 0) {
          pending = [];
          break;
        }
        pending = r.failed;
        if (attempt < maxR) {
          log.warn(
            { attempt: attempt + 1, failedSymbols: r.failed.length },
            'quote batch had failures; retrying failed symbols',
          );
          await new Promise((res) => setTimeout(res, 2000));
        } else {
          result.failures.push({
            capability: 'quotes',
            ingestor: quoteIngestor.name,
            reason: `${r.failed.length} symbols failed after ${maxR + 1} attempt(s): ${r.failed.slice(0, 5).join(', ')}${r.failed.length > 5 ? '...' : ''}`,
          });
        }
      }
      result.quotesWritten = totalWritten;
      log.info(
        {
          ingestor: quoteIngestor.name,
          written: result.quotesWritten,
          remainingFailed: pending.length,
        },
        'quotes ingested',
      );
    } catch (err) {
      result.failures.push({
        capability: 'quotes',
        ingestor: quoteIngestor.name,
        reason: (err as Error).message,
      });
      log.warn({ err: (err as Error).message }, 'quote ingestor failed');
    }
  }

  // ---- FII / DII (NSE) ----
  const fiiIngestor = pickIngestor('fii_dii');
  if (fiiIngestor?.fetchFiiDii) {
    try {
      const r = await fiiIngestor.fetchFiiDii(ctx);
      result.fiiDiiWritten = upsertFiiDii(r.data);
      log.info({ ingestor: fiiIngestor.name, written: result.fiiDiiWritten }, 'fii/dii ingested');
    } catch (err) {
      result.failures.push({
        capability: 'fii_dii',
        ingestor: fiiIngestor.name,
        reason: (err as Error).message,
      });
      log.warn({ err: (err as Error).message }, 'fii/dii ingestor failed');
    }
  }

  // ---- News (RSS) ----
  const newsIngestor = pickIngestor('news');
  if (newsIngestor?.fetchNews) {
    try {
      const r = await newsIngestor.fetchNews(ctx);
      result.newsWritten = insertNews(r.data);
      if (r.failed.length) {
        result.failures.push({
          capability: 'news',
          ingestor: newsIngestor.name,
          reason: `${r.failed.length} feeds failed`,
        });
      }
      log.info({ ingestor: newsIngestor.name, written: result.newsWritten }, 'news ingested');
    } catch (err) {
      result.failures.push({
        capability: 'news',
        ingestor: newsIngestor.name,
        reason: (err as Error).message,
      });
      log.warn({ err: (err as Error).message }, 'news ingestor failed');
    }
  }

  // ---- Fundamentals (Screener.in) ----
  const fundIngestor = pickIngestor('fundamentals');
  if (fundIngestor?.fetchFundamentals) {
    try {
      const r = await fundIngestor.fetchFundamentals(ctx);
      result.fundamentalsWritten = upsertFundamentals(r.data);
      if (r.failed.length) {
        result.failures.push({
          capability: 'fundamentals',
          ingestor: fundIngestor.name,
          reason: `${r.failed.length} symbols failed: ${r.failed.slice(0, 5).join(', ')}`,
        });
      }
      log.info(
        { ingestor: fundIngestor.name, written: result.fundamentalsWritten },
        'fundamentals ingested',
      );
    } catch (err) {
      result.failures.push({
        capability: 'fundamentals',
        ingestor: fundIngestor.name,
        reason: (err as Error).message,
      });
      log.warn({ err: (err as Error).message }, 'fundamentals ingestor failed');
    }
  }

  return result;
}
