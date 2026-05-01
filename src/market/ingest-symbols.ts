/**
 * Default symbol universe for daily quote ingest and technical enrichment:
 * watchlist + latest portfolio holdings + benchmark indices.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { loadWatchlist } from '../config/loaders.js';
import { getLatestHoldings } from '../db/index.js';
import { BENCHMARK_QUOTE_SYMBOLS, GLOBAL_MACRO_QUOTE_SYMBOLS } from './benchmarks.js';

/**
 * When `explicit` is omitted, merges watchlist symbols with all symbols from
 * the latest `portfolio_holdings` snapshot plus benchmark tickers. Requires
 * portfolio sync to have run first if you need holding symbols in the set.
 */
export function defaultIngestSymbolUniverse(db: DatabaseType, explicit?: string[]): string[] {
  const base = (explicit ?? loadWatchlist().symbols).map((s) => s.toUpperCase());
  const holdingSyms = getLatestHoldings(db).map((h) => h.symbol.toUpperCase());
  return [
    ...new Set([
      ...base,
      ...holdingSyms,
      ...BENCHMARK_QUOTE_SYMBOLS,
      ...GLOBAL_MACRO_QUOTE_SYMBOLS,
    ]),
  ];
}
