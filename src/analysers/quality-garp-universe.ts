import type { Database as DatabaseType } from 'better-sqlite3';
import { loadWatchlist } from '../config/loaders.js';

/** How the quality_garp symbol list was resolved for this run. */
export type QualityGarpUniverseScope = 'yahoo_annual' | 'watchlist' | 'override';

export interface QualityGarpSymbolResolution {
  symbols: string[];
  universeScope: QualityGarpUniverseScope;
}

/**
 * Live + backtest default: all symbols with `yahoo_annual` fundamentals (~241).
 * Matches audit denominators and backtest `resolveBacktestSymbols`.
 */
export function resolveQualityGarpSymbols(
  db: DatabaseType,
  overrideSymbols?: string[],
): QualityGarpSymbolResolution {
  if (overrideSymbols != null) {
    return {
      symbols: overrideSymbols.map((s) => s.toUpperCase()),
      universeScope: 'override',
    };
  }

  const symbols = (
    db
      .prepare(`SELECT DISTINCT symbol FROM fundamentals WHERE source = 'yahoo_annual'`)
      .pluck()
      .all() as string[]
  ).map((s) => s.toUpperCase());

  return { symbols, universeScope: 'yahoo_annual' };
}

/** Watchlist-only resolution (legacy); not used by live quality_garp today. */
export function resolveQualityGarpWatchlistSymbols(): QualityGarpSymbolResolution {
  return {
    symbols: loadWatchlist().symbols.map((s) => s.toUpperCase()),
    universeScope: 'watchlist',
  };
}
