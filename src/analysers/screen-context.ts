import type { Database as DatabaseType } from 'better-sqlite3';
import { loadEtfExclusions, loadScreens, loadWatchlist } from '../config/loaders.js';
import { getDistinctOpenPaperTradeSymbols, getLatestHoldings } from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import type { ScreenDefinition } from '../types/domain.js';
import type { Regime } from '../types/regime.js';
import { DbSignalProvider, type SignalProvider } from './signal-provider.js';

export interface ScreenContextOptions {
  date?: string;
  symbols?: string[];
  screens?: ScreenDefinition[];
  onlyScreen?: string;
  provider?: SignalProvider;
  persist?: boolean;
  regime?: Regime;
}

export function resolveScreenContext(opts: ScreenContextOptions, db: DatabaseType) {
  const date = opts.date ?? isoDateIst();
  const requestedSymbols = opts.symbols?.map((s) => s.toUpperCase());
  const dslSymbols = requestedSymbols ?? loadWatchlist().symbols.map((s) => s.toUpperCase());
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
