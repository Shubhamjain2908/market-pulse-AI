/**
 * Bulk quote load for Option A backtests.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import type { OHLCVBar } from './signals.js';

export function loadOhlcvMap(
  symbols: string[],
  dateFrom: string,
  dateTo: string,
  db: DatabaseType,
): Map<string, OHLCVBar[]> {
  const map = new Map<string, OHLCVBar[]>();
  if (symbols.length === 0) return map;
  const upper = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const ph = upper.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
      SELECT symbol, date, open, high, low, close, volume,
        COALESCE(adj_close, close) AS adjClose
      FROM quotes
      WHERE symbol IN (${ph}) AND exchange = 'NSE'
        AND date >= ? AND date <= ?
      ORDER BY symbol ASC, date ASC
    `,
    )
    .all(...upper, dateFrom, dateTo) as Array<{
    symbol: string;
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    adjClose: number;
  }>;

  for (const r of rows) {
    const sym = r.symbol.toUpperCase();
    const list = map.get(sym) ?? [];
    list.push({
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      adjClose: r.adjClose,
    });
    map.set(sym, list);
  }
  return map;
}

export function countDistinctQuoteDates(
  symbol: string,
  from: string,
  to: string,
  db: DatabaseType,
): number {
  const row = db
    .prepare(
      `
      SELECT COUNT(DISTINCT date) AS c FROM quotes
      WHERE symbol = ? AND exchange = 'NSE' AND date >= ? AND date <= ?
    `,
    )
    .get(symbol.toUpperCase(), from, to) as { c: number };
  return row.c;
}

export function quoteDateBounds(
  symbol: string,
  db: DatabaseType,
): { minD: string | null; maxD: string | null } {
  const row = db
    .prepare(
      `
      SELECT MIN(date) AS mn, MAX(date) AS mx FROM quotes
      WHERE symbol = ? AND exchange = 'NSE'
    `,
    )
    .get(symbol.toUpperCase()) as { mn: string | null; mx: string | null };
  return { minD: row.mn, maxD: row.mx };
}
