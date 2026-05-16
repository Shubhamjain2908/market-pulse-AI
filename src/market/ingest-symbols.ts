/**
 * Default symbol universe for daily quote ingest and technical enrichment:
 * watchlist + latest portfolio holdings + benchmark indices.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getMomentumUniverseSymbols, loadPortfolio, loadWatchlist } from '../config/loaders.js';
import { getLatestHoldings } from '../db/index.js';
import { BENCHMARK_QUOTE_SYMBOLS, GLOBAL_MACRO_QUOTE_SYMBOLS } from './benchmarks.js';

/**
 * Union of symbols from `config/watchlist.json`, all buckets in
 * `config/momentum-universe.json`, `config/portfolio.json` holdings, and the
 * latest `portfolio_holdings` DB snapshot — deduped, uppercased, sorted.
 * Used by `mp ingest -s all` so fundamentals (and the rest of stage-1 ingest)
 * cover the same equity set without index/macro tickers.
 */
export function getIngestAllEquitySymbolsUnion(db: DatabaseType): string[] {
  const set = new Set<string>();
  for (const s of loadWatchlist().symbols) {
    set.add(s.toUpperCase());
  }
  try {
    for (const s of getMomentumUniverseSymbols()) {
      set.add(s);
    }
  } catch {
    // Optional until config/momentum-universe.json exists in a clone.
  }
  for (const h of loadPortfolio().holdings) {
    set.add(h.symbol.toUpperCase());
  }
  for (const h of getLatestHoldings(db)) {
    set.add(h.symbol.toUpperCase());
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * When `explicit` is omitted, merges watchlist symbols with all symbols from
 * the latest `portfolio_holdings` snapshot plus benchmark tickers. Requires
 * portfolio sync to have run first if you need holding symbols in the set.
 */
export function defaultIngestSymbolUniverse(db: DatabaseType, explicit?: string[]): string[] {
  const base = (explicit ?? loadWatchlist().symbols).map((s) => s.toUpperCase());
  const holdingSyms = getLatestHoldings(db).map((h) => h.symbol.toUpperCase());
  let momentumSyms: string[] = [];
  try {
    momentumSyms = getMomentumUniverseSymbols();
  } catch {
    // Optional until config/momentum-universe.json is committed in new clones.
  }
  return [
    ...new Set([
      ...base,
      ...holdingSyms,
      ...momentumSyms,
      ...BENCHMARK_QUOTE_SYMBOLS,
      ...GLOBAL_MACRO_QUOTE_SYMBOLS,
    ]),
  ];
}
