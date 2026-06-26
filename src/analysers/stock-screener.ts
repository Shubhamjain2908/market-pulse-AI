import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/index.js';
import type { ScreenDefinition } from '../types/domain.js';
import type { Regime } from '../types/regime.js';
import { CATALYST_ENTRY_SCREEN, runCatalystEntryScreen } from './catalyst-entry-screen.js';
import type { ScreenEngineResult } from './engine.js';
import { runScreenEngine } from './engine.js';
import { QUALITY_GARP_SCREEN, type QualityGarpFunnelCounts } from './quality-garp.js';
import { runQualityGarpScreen } from './quality-garp-screen.js';
import { resolveScreenContext } from './screen-context.js';
import type { SignalProvider } from './signal-provider.js';

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
  const context = resolveScreenContext(opts, db);

  const qualityScreen = context.screens.find((s) => s.name === QUALITY_GARP_SCREEN);
  const catalystScreen = context.screens.find((s) => s.name === CATALYST_ENTRY_SCREEN);
  const dslScreens = context.screens.filter(
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
        date: context.date,
        symbols: context.dslSymbols,
        screens: dslScreens,
        provider: context.provider,
        persist: context.persist,
        regime: context.regime,
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
        date: context.date,
        symbols: context.requestedSymbols,
        provider: context.provider,
        persist: context.persist,
        regime: context.regime,
        etfExclusions: context.etfExclusions,
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
        date: context.date,
        persist: context.persist,
        regime: context.regime,
        etfExclusions: context.etfExclusions,
        alreadyOwned: context.alreadyOwned,
      },
      db,
    );
    matchesByScreen[CATALYST_ENTRY_SCREEN] = catalystResult.matches;
    partialByScreen[CATALYST_ENTRY_SCREEN] = catalystResult.partial;
    evaluations.push(...catalystResult.evaluations);
    screensApplied.push(CATALYST_ENTRY_SCREEN);
  }

  return {
    date: context.date,
    screensApplied,
    matchesByScreen,
    partialByScreen,
    funnelByScreen: Object.keys(funnelByScreen).length > 0 ? funnelByScreen : undefined,
    evaluations,
  };
}
