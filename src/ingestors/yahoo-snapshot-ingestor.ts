/**
 * Yahoo Finance `quoteSummary` point-in-time valuation snapshot → `fundamentals`.
 * Runs post-enrich; fail-open (never throws to workflow callers).
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import YahooFinance from 'yahoo-finance2';
import { getDb } from '../db/index.js';
import { child } from '../logger.js';
import { addCalendarDaysIst } from '../market/trading-days.js';
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
  netProfitTtm: number | null;
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

/**
 * PEG when Yahoo omits `trailingPegRatio` (common on `.NS` quoteSummary as of 2026).
 * `earningsGrowth` is a decimal fraction (0.12 = 12% YoY).
 */
export function derivePegRatio(pe: number | null, earningsGrowth: number | null): number | null {
  if (pe === null || earningsGrowth === null || earningsGrowth <= 0) return null;
  const growthPct = earningsGrowth * 100;
  if (growthPct < 0.5) return null;
  const peg = pe / growthPct;
  return Number.isFinite(peg) && peg > 0 ? peg : null;
}

/** Yahoo reports net income in absolute INR; store crores (Screener convention). */
export function netIncomeToCrores(raw: unknown): number | null {
  const n = toFiniteNumber(raw);
  if (n === null) return null;
  return n / 1e7;
}

/**
 * Pick TTM net income from a fundamentalsTimeSeries row (absolute INR).
 * Prefer `normalizedIncome` — NSE listings often report distorted `netIncome` after
 * one-off items (e.g. IDEA AGR settlement) while normalized stays loss-making.
 */
export function pickNetIncomeFromTimeSeriesRow(row: Record<string, unknown>): number | null {
  const normalized = toFiniteNumber(row.normalizedIncome);
  if (normalized !== null) return normalized;
  return (
    toFiniteNumber(row.netIncomeCommonStockholders) ??
    toFiniteNumber(row.dilutedNIAvailtoComStockholders) ??
    toFiniteNumber(row.netIncome)
  );
}

/** Latest trailing fundamentalsTimeSeries row with income → crores. */
export function netProfitTtmFromTimeSeriesRows(rows: unknown[]): number | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const withIncome = rows.filter((r) => {
    if (r == null || typeof r !== 'object') return false;
    return pickNetIncomeFromTimeSeriesRow(r as Record<string, unknown>) !== null;
  });
  const latest = withIncome[withIncome.length - 1] as Record<string, unknown> | undefined;
  if (!latest) return null;
  return netIncomeToCrores(pickNetIncomeFromTimeSeriesRow(latest));
}

async function fetchNetProfitTtmFromTimeSeries(
  client: InstanceType<typeof YahooFinance>,
  yTicker: string,
  asOf: string,
): Promise<number | null> {
  try {
    const rows = await client.fundamentalsTimeSeries(
      yTicker,
      {
        period1: addCalendarDaysIst(asOf, -730),
        type: 'trailing',
        module: 'financials',
      },
      { validateResult: false },
    );
    return netProfitTtmFromTimeSeriesRows(rows);
  } catch (err) {
    if (isYahooMissingSymbolError(err)) {
      log.debug(
        { yTicker, err: (err as Error).message },
        'yahoo fundamentalsTimeSeries unavailable for symbol',
      );
    } else {
      log.debug(
        { yTicker, err: (err as Error).message },
        'yahoo fundamentalsTimeSeries net profit fetch failed',
      );
    }
    return null;
  }
}

export function mapQuoteSummaryToSnapshot(
  symbol: string,
  asOf: string,
  summary: {
    summaryDetail?: {
      trailingPE?: unknown;
      marketCap?: unknown;
      dividendYield?: unknown;
      netIncomeToCommon?: unknown;
    };
    defaultKeyStatistics?: { priceToBook?: unknown; trailingPegRatio?: unknown };
    financialData?: {
      returnOnEquity?: unknown;
      debtToEquity?: unknown;
      earningsGrowth?: unknown;
      netIncomeToCommon?: unknown;
    };
    price?: { trailingPE?: unknown };
  },
): YahooSnapshotFields | null {
  const pe =
    toFiniteNumber(summary.summaryDetail?.trailingPE) ?? toFiniteNumber(summary.price?.trailingPE);
  const pb = toFiniteNumber(summary.defaultKeyStatistics?.priceToBook);
  const earningsGrowth = toFiniteNumber(summary.financialData?.earningsGrowth);
  const peg =
    toFiniteNumber(summary.defaultKeyStatistics?.trailingPegRatio) ??
    derivePegRatio(pe, earningsGrowth);
  const marketCap = toFiniteNumber(summary.summaryDetail?.marketCap);
  const dividendYield = toFiniteNumber(summary.summaryDetail?.dividendYield);
  const roe = toFiniteNumber(summary.financialData?.returnOnEquity);
  const debtToEquity = normalizeDebtToEquity(summary.financialData?.debtToEquity);
  const netProfitTtm =
    netIncomeToCrores(summary.summaryDetail?.netIncomeToCommon) ??
    netIncomeToCrores(summary.financialData?.netIncomeToCommon);

  const values = [pe, pb, peg, marketCap, dividendYield, roe, debtToEquity, netProfitTtm];
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
    netProfitTtm,
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
      debt_to_equity, dividend_yield, net_profit_ttm, source, ingested_at
    ) VALUES (
      @symbol, @asOf, @marketCap, @pe, @pb, @peg, @roe,
      @debtToEquity, @dividendYield, @netProfitTtm, @source, datetime('now')
    )
    ON CONFLICT(symbol, as_of) DO UPDATE SET
      market_cap     = excluded.market_cap,
      pe             = excluded.pe,
      pb             = excluded.pb,
      peg            = excluded.peg,
      roe            = excluded.roe,
      debt_to_equity = excluded.debt_to_equity,
      dividend_yield = excluded.dividend_yield,
      net_profit_ttm = COALESCE(excluded.net_profit_ttm, fundamentals.net_profit_ttm),
      source         = excluded.source,
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
        netProfitTtm: r.netProfitTtm,
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
            let row = mapQuoteSummaryToSnapshot(
              symbol,
              asOf,
              summary as Parameters<typeof mapQuoteSummaryToSnapshot>[2],
            );
            if (row !== null && row.netProfitTtm === null) {
              const fromTs = await fetchNetProfitTtmFromTimeSeries(client, yTicker, asOf);
              if (fromTs !== null) {
                row = { ...row, netProfitTtm: fromTs };
              }
            }
            return row;
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
