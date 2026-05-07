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
 * Earnings blackout around `expected_date` in `earnings_calendar` (±`windowDays` calendar days).
 * Fail-open: returns false when no matching row (including empty table / Yahoo miss).
 *
 * Blackout is risk-reduction only — missing data must NOT block entries.
 */
export function isInEarningsBlackoutCalendarWindow(
  symbol: string,
  refDate: string,
  db: DatabaseType = getDb(),
  windowDays = 3,
): boolean {
  const row = db
    .prepare(
      `
      SELECT 1 AS ok FROM earnings_calendar
      WHERE symbol = ?
        AND expected_date BETWEEN date(?, printf('-%d days', ?)) AND date(?, printf('+%d days', ?))
      LIMIT 1
    `,
    )
    .get(symbol.toUpperCase(), refDate, windowDays, refDate, windowDays) as
    | { ok: number }
    | undefined;
  return row != null;
}

/**
 * Replace all calendar rows for a symbol with at most one upcoming earnings row.
 * Passing `null` clears the symbol (fail-open after Yahoo miss / stale data).
 */
export function replaceMomentumEarningsCalendarForSymbol(
  symbol: string,
  expectedDateIso: string | null,
  db: DatabaseType,
  meta: { source: string; fetchedAt: string },
): void {
  const sym = symbol.toUpperCase();
  db.prepare('DELETE FROM earnings_calendar WHERE symbol = ?').run(sym);
  if (expectedDateIso) {
    db.prepare(
      `
      INSERT INTO earnings_calendar (symbol, expected_date, source, fetched_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run(sym, expectedDateIso, meta.source, meta.fetchedAt);
  }
}

/** Factor signals written daily by the momentum enricher (Factor 2 uses fundamentals at rank time). */
export const MOMENTUM_FACTOR_SIGNAL_NAMES = [
  'mom_12_1_return',
  'mom_relative_strength_ba',
  'mom_volume_breakout_flag',
] as const;

/** Removes momentum factor rows so downstream rankers treat factors as missing (NOT NULL column). */
export function deleteMomentumFactorSignals(symbol: string, date: string, db: DatabaseType): void {
  const sym = symbol.toUpperCase();
  const names = MOMENTUM_FACTOR_SIGNAL_NAMES;
  const ph = names.map(() => '?').join(',');
  db.prepare(`DELETE FROM signals WHERE symbol = ? AND date = ? AND name IN (${ph})`).run(
    sym,
    date,
    ...names,
  );
}

export function deleteSignalByName(
  symbol: string,
  date: string,
  name: string,
  db: DatabaseType,
): void {
  db.prepare('DELETE FROM signals WHERE symbol = ? AND date = ? AND name = ?').run(
    symbol.toUpperCase(),
    date,
    name,
  );
}
