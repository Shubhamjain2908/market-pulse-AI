import type { Database as DatabaseType } from 'better-sqlite3';
import { getSizeMultiplier, isStrategyAllowed } from '../db/index.js';
import { upsertScreenResults } from '../db/queries.js';
import { child } from '../logger.js';
import type { ScreenResult } from '../types/domain.js';
import type { Regime } from '../types/regime.js';
import { runCatalystScreener } from './catalyst-screener.js';
import type { ScreenEngineResult } from './engine.js';

const log = child({ component: 'stock-screener-analyser' });
export const CATALYST_ENTRY_SCREEN = 'catalyst_entry';

export function runCatalystEntryScreen(
  opts: {
    date: string;
    persist: boolean;
    regime?: Regime;
    etfExclusions: Set<string>;
    alreadyOwned: Set<string>;
  },
  db: DatabaseType,
): { matches: number; partial: number; evaluations: ScreenEngineResult['evaluations'] } {
  const { date, persist, regime, etfExclusions, alreadyOwned } = opts;

  if (regime != null && !isStrategyAllowed(CATALYST_ENTRY_SCREEN, regime, db)) {
    log.info({ screen: CATALYST_ENTRY_SCREEN, regime }, 'catalyst_entry gated by regime');
    return { matches: 0, partial: 0, evaluations: [] };
  }

  const candidates = runCatalystScreener(db, date, alreadyOwned, etfExclusions);
  const evaluations: ScreenEngineResult['evaluations'] = candidates.map((candidate) => ({
    symbol: candidate.symbol,
    date,
    screenName: CATALYST_ENTRY_SCREEN,
    criteria: [],
    matchedCount: 1,
    totalCriteria: 1,
    score: 1,
    passed: true,
  }));
  const results: ScreenResult[] = candidates.map((candidate) => {
    const matchedCriteria =
      regime == null
        ? { ...candidate }
        : {
            ...candidate,
            __regime_meta: {
              regime,
              sizeMultiplier: getSizeMultiplier(CATALYST_ENTRY_SCREEN, regime, db),
              strategyId: CATALYST_ENTRY_SCREEN,
            },
          };
    return {
      symbol: candidate.symbol,
      date,
      screenName: CATALYST_ENTRY_SCREEN,
      score: 1,
      matchedCriteria,
    };
  });

  if (persist) {
    upsertScreenResults(results, db);
  }

  return { matches: results.length, partial: 0, evaluations };
}
