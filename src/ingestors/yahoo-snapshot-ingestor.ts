/**
 * Yahoo Finance `quoteSummary` point-in-time valuation snapshot → `fundamentals`.
 * Runs post-enrich; fail-open (never throws to workflow callers).
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import YahooFinance from 'yahoo-finance2';
import { getDb } from '../db/index.js';
import { child } from '../logger.js';
import { isYahooMissingSymbolError } from '../market/yahoo-errors.js';
import { toYahooFinanceTicker } from '../market/yahoo-ticker.js';
import { isoDateIst } from './base/dates.js';

const log = child({ component: 'yahoo-snapshot-ingestor' });

export const YAHOO_SNAPSHOT_SOURCE = 'yahoo_snapshot';

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 500;

const QUOTE_SUMMARY_MODULES = ['summaryDetail', 'defaultKeyStatistics', 'financialData'] as const;

export interface YahooSnapshotFields {
  symbol: string;
  asOf: string;
  marketCap: number | null;
  pe: number | null;
  pb: number | null;
  peg: number | null;
  roe: number | null;
  debtToEquity: number | null;
  dividendYield: number | null;
}

export interface IngestYahooSnapshotsResult {
  attempted: number;
  written: number;
  failed: number;
  failedSymbols: string[];
}

export function toFiniteNumber(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Yahoo `.NS` listings report debtToEquity in percentage units — always scale to ratio. */
export function normalizeDebtToEquity(raw: unknown): number | null {
  const n = toFiniteNumber(raw);
  if (n === null) return null;
  return n / 100;
}

export function mapQuoteSummaryToSnapshot(
  symbol: string,
  asOf: string,
  summary: {
    summaryDetail?: { trailingPE?: unknown; marketCap?: unknown; dividendYield?: unknown };
    defaultKeyStatistics?: { priceToBook?: unknown; trailingPegRatio?: unknown };
    financialData?: { returnOnEquity?: unknown; debtToEquity?: unknown };
    price?: { trailingPE?: unknown };
  },
): YahooSnapshotFields | null {
  const pe =
    toFiniteNumber(summary.summaryDetail?.trailingPE) ?? toFiniteNumber(summary.price?.trailingPE);
  const pb = toFiniteNumber(summary.defaultKeyStatistics?.priceToBook);
  const peg = toFiniteNumber(summary.defaultKeyStatistics?.trailingPegRatio);
  const marketCap = toFiniteNumber(summary.summaryDetail?.marketCap);
  const dividendYield = toFiniteNumber(summary.summaryDetail?.dividendYield);
  const roe = toFiniteNumber(summary.financialData?.returnOnEquity);
  const debtToEquity = normalizeDebtToEquity(summary.financialData?.debtToEquity);

  const values = [pe, pb, peg, marketCap, dividendYield, roe, debtToEquity];
  if (values.every((v) => v === null)) return null;

  return {
    symbol: symbol.toUpperCase(),
    asOf,
    marketCap,
    pe,
    pb,
    peg,
    roe,
    debtToEquity,
    dividendYield,
  };
}

function listActiveEquitySymbols(db: DatabaseType): string[] {
  const rows = db
    .prepare('SELECT symbol FROM symbols WHERE is_active = 1 AND is_index = 0 ORDER BY symbol')
    .all() as { symbol: string }[];
  return rows.map((r) => r.symbol.toUpperCase());
}

function writeSnapshotRows(db: DatabaseType, rows: YahooSnapshotFields[]): number {
  if (rows.length === 0) return 0;

  const stmt = db.prepare(`
    INSERT INTO fundamentals (
      symbol, as_of, market_cap, pe, pb, peg, roe,
      debt_to_equity, dividend_yield, source, ingested_at
    ) VALUES (
      @symbol, @asOf, @marketCap, @pe, @pb, @peg, @roe,
      @debtToEquity, @dividendYield, @source, datetime('now')
    )
    ON CONFLICT(symbol, as_of) DO UPDATE SET
      market_cap     = excluded.market_cap,
      pe             = excluded.pe,
      pb             = excluded.pb,
      peg            = excluded.peg,
      roe            = excluded.roe,
      debt_to_equity = excluded.debt_to_equity,
      dividend_yield = excluded.dividend_yield,
      ingested_at    = excluded.ingested_at
  `);

  const tx = db.transaction((batch: YahooSnapshotFields[]) => {
    for (const r of batch) {
      stmt.run({
        symbol: r.symbol,
        asOf: r.asOf,
        marketCap: r.marketCap,
        pe: r.pe,
        pb: r.pb,
        peg: r.peg,
        roe: r.roe,
        debtToEquity: r.debtToEquity,
        dividendYield: r.dividendYield,
        source: YAHOO_SNAPSHOT_SOURCE,
      });
    }
  });
  tx(rows);
  return rows.length;
}

export async function ingestYahooSnapshots(
  db: DatabaseType = getDb(),
  opts: { date?: string } = {},
): Promise<IngestYahooSnapshotsResult> {
  const empty: IngestYahooSnapshotsResult = {
    attempted: 0,
    written: 0,
    failed: 0,
    failedSymbols: [],
  };

  try {
    const asOf = opts.date ?? isoDateIst();
    const symbols = listActiveEquitySymbols(db);
    if (symbols.length === 0) {
      log.info({ asOf }, 'yahoo snapshot ingest: no active equity symbols');
      return empty;
    }

    const client = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
    const failedSymbols: string[] = [];
    const rowsToWrite: YahooSnapshotFields[] = [];

    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map(async (symbol) => {
          const yTicker = toYahooFinanceTicker(symbol);
          try {
            const summary = await client.quoteSummary(
              yTicker,
              { modules: [...QUOTE_SUMMARY_MODULES] },
              { validateResult: false },
            );
            return mapQuoteSummaryToSnapshot(
              symbol,
              asOf,
              summary as Parameters<typeof mapQuoteSummaryToSnapshot>[2],
            );
          } catch (err) {
            if (isYahooMissingSymbolError(err)) {
              log.debug(
                { symbol, yTicker, err: (err as Error).message },
                'yahoo snapshot unavailable for symbol',
              );
            } else {
              log.warn(
                { symbol, yTicker, err: (err as Error).message },
                'yahoo snapshot fetch failed for symbol',
              );
            }
            return null;
          }
        }),
      );

      for (let j = 0; j < settled.length; j++) {
        const sym = batch[j];
        const outcome = settled[j];
        if (sym === undefined || outcome === undefined) continue;
        if (outcome.status === 'rejected') {
          failedSymbols.push(sym);
          log.warn(
            { symbol: sym, err: (outcome.reason as Error)?.message ?? String(outcome.reason) },
            'yahoo snapshot batch item rejected unexpectedly',
          );
          continue;
        }
        const row = outcome.value;
        if (row === null) {
          failedSymbols.push(sym);
        } else {
          rowsToWrite.push(row);
        }
      }

      if (i + BATCH_SIZE < symbols.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    const written = writeSnapshotRows(db, rowsToWrite);
    const result: IngestYahooSnapshotsResult = {
      attempted: symbols.length,
      written,
      failed: failedSymbols.length,
      failedSymbols,
    };
    log.info(result, 'yahoo snapshot ingest done');
    return result;
  } catch (err) {
    log.error({ err: (err as Error).message }, 'yahoo snapshot ingest catastrophic failure');
    return empty;
  }
}
