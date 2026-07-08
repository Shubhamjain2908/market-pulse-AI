import type { Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config/env.js';
import { loadEtfExclusions, loadScreens, loadWatchlist } from '../config/loaders.js';
import { getDistinctOpenPaperTradeSymbols, getLatestHoldings } from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';
import type { ScreenDefinition } from '../types/domain.js';
import type { Regime } from '../types/regime.js';
import { DbSignalProvider, type SignalProvider } from './signal-provider.js';

const log = child({ component: 'screen-context' });

export interface ScreenContextOptions {
  date?: string;
  symbols?: string[];
  screens?: ScreenDefinition[];
  onlyScreen?: string;
  provider?: SignalProvider;
  persist?: boolean;
  regime?: Regime;
}

/**
 * Resolve the DSL screen symbol list based on `SCREEN_UNIVERSE` config.
 * - `'watchlist'` — legacy 15-symbol watchlist.
 * - `'signals'`  — all symbols with enriched signals on the given date (~200).
 * - `'momentum'` — symbols with a momentum rank on the given date (~157).
 */
function resolveScreenUniverse(db: DatabaseType, date: string): string[] {
  switch (config.SCREEN_UNIVERSE) {
    case 'signals': {
      const symbols = db
        .prepare('SELECT DISTINCT symbol FROM signals WHERE date = ?')
        .pluck()
        .all(date) as string[];
      log.info({ universe: 'signals', count: symbols.length, date }, 'screen universe resolved');
      return symbols.map((s) => s.toUpperCase());
    }
    case 'momentum': {
      const symbols = db
        .prepare("SELECT DISTINCT symbol FROM signals WHERE date = ? AND name = 'mom_rank'")
        .pluck()
        .all(date) as string[];
      log.info({ universe: 'momentum', count: symbols.length, date }, 'screen universe resolved');
      return symbols.map((s) => s.toUpperCase());
    }
    default: {
      // ponytail: 'watchlist' — legacy path, no DB hit
      const symbols = loadWatchlist().symbols.map((s) => s.toUpperCase());
      log.info({ universe: 'watchlist', count: symbols.length }, 'screen universe resolved');
      return symbols;
    }
  }
}

export function resolveScreenContext(opts: ScreenContextOptions, db: DatabaseType) {
  const date = opts.date ?? isoDateIst();
  const requestedSymbols = opts.symbols?.map((s) => s.toUpperCase());
  const dslSymbols = requestedSymbols ?? resolveScreenUniverse(db, date);
  let screens = opts.screens ?? loadScreens();

  if (opts.onlyScreen) {
    screens = screens.filter((s) => s.name === opts.onlyScreen);
    if (screens.length === 0) {
      throw new Error(`No screen named "${opts.onlyScreen}" found in config/screens.json`);
    }
  }

  return {
    date,
    requestedSymbols,
    dslSymbols,
    screens,
    provider: opts.provider ?? new DbSignalProvider(db),
    persist: opts.persist ?? true,
    regime: opts.regime,
    etfExclusions: new Set(loadEtfExclusions().map((s) => s.toUpperCase())),
    alreadyOwned: new Set([
      ...getLatestHoldings(db).map((h) => h.symbol.toUpperCase()),
      ...getDistinctOpenPaperTradeSymbols(db).map((s) => s.toUpperCase()),
    ]),
  };
}
