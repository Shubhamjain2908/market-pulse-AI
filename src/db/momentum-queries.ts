/**
 * SQLite helpers for momentum screener (cold-start guards, earnings blackout calendar).
 * Business rules for ranking/rebalance live in rankers/strategies — keep this layer thin.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { getDb } from './connection.js';

/**
 * True when the symbol has at least `minTradingDays` quote rows on or before `asOf` (NSE).
 */
export function hasMinPriceHistory(
  symbol: string,
  minTradingDays: number,
  asOf: string,
  db: DatabaseType = getDb(),
): boolean {
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS c FROM quotes
      WHERE symbol = ? AND exchange = 'NSE' AND date <= ?
    `,
    )
    .get(symbol.toUpperCase(), asOf) as { c: number };
  return row.c >= minTradingDays;
}

/**
 * Earnings blackout around `expected_date` in `earnings_calendar` (±3 calendar days per product spec).
 * Fail-open: returns false when no matching row (including empty table / Yahoo miss).
 *
 * Blackout is risk-reduction only — missing data must NOT block entries.
 */
export function isInEarningsBlackoutCalendarWindow(
  symbol: string,
  refDate: string,
  db: DatabaseType = getDb(),
): boolean {
  const row = db
    .prepare(
      `
      SELECT 1 AS ok FROM earnings_calendar
      WHERE symbol = ?
        AND expected_date BETWEEN date(?, '-3 days') AND date(?, '+3 days')
      LIMIT 1
    `,
    )
    .get(symbol.toUpperCase(), refDate, refDate) as { ok: number } | undefined;
  return row != null;
}
