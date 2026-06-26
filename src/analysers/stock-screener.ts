import type { Database as DatabaseType } from 'better-sqlite3';
import { loadEtfExclusions, loadScreens, loadWatchlist } from '../config/loaders.js';
import { getDb, getDistinctOpenPaperTradeSymbols, getLatestHoldings } from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import type { ScreenDefinition } from '../types/domain.js';
import type { Regime } from '../types/regime.js';
import { CATALYST_ENTRY_SCREEN, runCatalystEntryScreen } from './catalyst-entry-screen.js';
import type { ScreenEngineResult } from './engine.js';
import { runScreenEngine } from './engine.js';
import { QUALITY_GARP_SCREEN, type QualityGarpFunnelCounts } from './quality-garp.js';
import { runQualityGarpScreen } from './quality-garp-screen.js';
import { DbSignalProvider, type SignalProvider } from './signal-provider.js';

export interface StockScreenerOptions {
  date?: string;
  symbols?: string[];
  screens?: ScreenDefinition[];
  onlyScreen?: string;
  provider?: SignalProvider;
  persist?: boolean;
  regime?: Regime;
  /** Backtest replay: fundamentals as_of <= screen date. Live paths omit this. */
  pointInTimeFundamentals?: boolean;
}

export function runStockScreenAnalyser(
  opts: StockScreenerOptions = {},
  db: DatabaseType = getDb(),
): ScreenEngineResult {
  const date = opts.date ?? isoDateIst();
  const symbols = (opts.symbols ?? loadWatchlist().symbols).map((s) => s.toUpperCase());
  let screens = opts.screens ?? loadScreens();

  if (opts.onlyScreen) {
    screens = screens.filter((s) => s.name === opts.onlyScreen);
    if (screens.length === 0) {
      throw new Error(`No screen named "${opts.onlyScreen}" found in config/screens.json`);
    }
  }

  const provider = opts.provider ?? new DbSignalProvider(db);
  const persist = opts.persist ?? true;
  const etfExclusions = new Set(loadEtfExclusions().map((s) => s.toUpperCase()));
  const alreadyOwned = new Set([
    ...getLatestHoldings(db).map((h) => h.symbol.toUpperCase()),
    ...getDistinctOpenPaperTradeSymbols(db).map((s) => s.toUpperCase()),
  ]);

  const qualityScreen = screens.find((s) => s.name === QUALITY_GARP_SCREEN);
  const catalystScreen = screens.find((s) => s.name === CATALYST_ENTRY_SCREEN);
  const dslScreens = screens.filter(
    (s) => s.name !== QUALITY_GARP_SCREEN && s.name !== CATALYST_ENTRY_SCREEN,
  );

  const matchesByScreen: Record<string, number> = {};
  const partialByScreen: Record<string, number> = {};
  const funnelByScreen: Record<string, QualityGarpFunnelCounts> = {};
  const evaluations = [];
  const screensApplied: string[] = [];

  if (dslScreens.length > 0) {
    const dslResult = runScreenEngine(
      {
        date,
        symbols,
        screens: dslScreens,
        provider,
        persist,
        regime: opts.regime,
      },
      db,
    );
    Object.assign(matchesByScreen, dslResult.matchesByScreen);
    Object.assign(partialByScreen, dslResult.partialByScreen);
    evaluations.push(...dslResult.evaluations);
    screensApplied.push(...dslResult.screensApplied);
  }

  if (qualityScreen) {
    const qualityResult = runQualityGarpScreen(
      {
        date,
        symbols: opts.symbols,
        provider,
        persist,
        regime: opts.regime,
        etfExclusions,
        pointInTimeFundamentals: opts.pointInTimeFundamentals,
      },
      db,
    );
    matchesByScreen[QUALITY_GARP_SCREEN] = qualityResult.matches;
    partialByScreen[QUALITY_GARP_SCREEN] = qualityResult.partial;
    funnelByScreen[QUALITY_GARP_SCREEN] = qualityResult.funnel;
    evaluations.push(...qualityResult.evaluations);
    screensApplied.push(QUALITY_GARP_SCREEN);
  }

  if (catalystScreen) {
    const catalystResult = runCatalystEntryScreen(
      {
        date,
        persist,
        regime: opts.regime,
        etfExclusions,
        alreadyOwned,
      },
      db,
    );
    matchesByScreen[CATALYST_ENTRY_SCREEN] = catalystResult.matches;
    partialByScreen[CATALYST_ENTRY_SCREEN] = catalystResult.partial;
    evaluations.push(...catalystResult.evaluations);
    screensApplied.push(CATALYST_ENTRY_SCREEN);
  }

  return {
    date,
    screensApplied,
    matchesByScreen,
    partialByScreen,
    funnelByScreen: Object.keys(funnelByScreen).length > 0 ? funnelByScreen : undefined,
    evaluations,
  };
}
