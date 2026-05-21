/**
 * Shared momentum-universe filtering for Option A (quote depth in window).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { countDistinctQuoteDates, quoteDateBounds } from './quotes-loader.js';

export function filterOptionAUniverse(
  universe: string[],
  from: string,
  to: string,
  minHistoryDays: number,
  db: DatabaseType,
): string[] {
  const out: string[] = [];
  for (const sym of universe) {
    const u = sym.toUpperCase();
    const n = countDistinctQuoteDates(u, from, to, db);
    if (n >= minHistoryDays) {
      out.push(u);
      continue;
    }
    if (n >= 252 && n < minHistoryDays) {
      const { minD, maxD } = quoteDateBounds(u, db);
      if (minD && maxD && minD <= from && maxD >= to) out.push(u);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}
