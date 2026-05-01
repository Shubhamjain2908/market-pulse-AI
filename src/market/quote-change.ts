/**
 * Latest quote helpers for benchmarks and macro symbols (session-over-session Δ%).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

export function latestQuoteClose(
  symbol: string,
  date: string,
  db: DatabaseType,
): { close: number; asOf: string } | undefined {
  const latest = db
    .prepare(
      `
      SELECT date, close FROM quotes
      WHERE symbol = ? AND date <= ?
      ORDER BY date DESC LIMIT 1
    `,
    )
    .get(symbol, date) as { date: string; close: number } | undefined;
  if (!latest) return undefined;
  return { close: latest.close, asOf: latest.date };
}

/** Latest bar vs prior session close on the same symbol (same logic as Nifty Δ in Market Mood). */
export function sessionChangeVsPriorClose(
  symbol: string,
  date: string,
  db: DatabaseType,
): { changePct: number; asOf: string } | undefined {
  const latest = db
    .prepare(
      `
      SELECT date, close FROM quotes
      WHERE symbol = ? AND date <= ?
      ORDER BY date DESC LIMIT 1
    `,
    )
    .get(symbol, date) as { date: string; close: number } | undefined;
  if (!latest) return undefined;
  const prev = db
    .prepare(
      `
      SELECT close FROM quotes
      WHERE symbol = ? AND date < ?
      ORDER BY date DESC LIMIT 1
    `,
    )
    .get(symbol, latest.date) as { close: number } | undefined;
  if (!prev || prev.close <= 0) return { changePct: 0, asOf: latest.date };
  const changePct = ((latest.close - prev.close) / prev.close) * 100;
  return { changePct, asOf: latest.date };
}
