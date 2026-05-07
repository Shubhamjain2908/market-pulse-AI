/**
 * Writes `mom_earnings_blackout` (0/1) from `earnings_calendar` for the ingest universe.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { loadMomentumConfig } from '../config/loaders.js';
import { getDb, isInEarningsBlackoutCalendarWindow, upsertSignals } from '../db/index.js';
import type { Signal } from '../types/domain.js';

export function upsertMomentumEarningsBlackoutSignals(
  date: string,
  symbols: string[],
  db: DatabaseType = getDb(),
): number {
  const windowDays = loadMomentumConfig().earnings_blackout_days;
  const rows: Signal[] = [];
  for (const raw of symbols) {
    const symbol = raw.toUpperCase();
    const blackout = isInEarningsBlackoutCalendarWindow(symbol, date, db, windowDays);
    rows.push({
      symbol,
      date,
      name: 'mom_earnings_blackout',
      value: blackout ? 1 : 0,
      source: 'momentum',
    });
  }
  return upsertSignals(rows, db);
}
