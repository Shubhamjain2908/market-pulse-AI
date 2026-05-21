/**
 * Option A backtest engine — thin orchestration over strategy modules.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { NIFTY_BENCHMARK_SYMBOL } from '../market/benchmarks.js';
import {
  type OptionARegimeSource,
  type RegimeProxyMap,
  buildRegimeProxyMapForOptionAWindow,
} from './regime-proxy.js';
import { runAiPickBacktest } from './strategies/ai-pick.js';
import { runMomentumMfBacktest } from './strategies/momentum-mf.js';
import type { ClosedSimTrade } from './types.js';
import { filterOptionAUniverse } from './universe-filter.js';

export type OptionAStrategy = 'momentum-mf' | 'ai-pick' | 'all';

export type { OptionARegimeSource } from './regime-proxy.js';

export interface RunOptionAEngineOpts {
  strategy: OptionAStrategy;
  from: string;
  to: string;
  costBpsRoundTrip: number;
  minHistoryDays: number;
  /** Initial ATR stop multiplier for momentum-mf (Phase 1 sweep). */
  initialMultiplier?: number;
  /** Tightened ATR multiplier after lock-in (Phase 2 sweep). */
  tightenedMultiplier?: number;
  /** Peak gain % to activate tightened trail (Phase 2 sweep). */
  lockInThresholdPct?: number;
  universe?: string[];
  db: DatabaseType;
  regimeSource?: OptionARegimeSource;
}

export interface RunOptionAEngineResult {
  byStrategy: {
    momentum_mf?: ClosedSimTrade[];
    ai_pick?: ClosedSimTrade[];
  };
  /** Universe after quote-depth filter (matches strategy eligibility). */
  universeUsed: string[];
}

export function runOptionAEngine(opts: RunOptionAEngineOpts): RunOptionAEngineResult {
  const byStrategy: RunOptionAEngineResult['byStrategy'] = {};
  const regimeSource: OptionARegimeSource = opts.regimeSource ?? 'proxy';

  let regimeProxyByDate: RegimeProxyMap | undefined;
  let universeForStrategies = opts.universe;

  if (regimeSource === 'proxy' && opts.universe != null && opts.universe.length > 0) {
    const built = buildRegimeProxyMapForOptionAWindow({
      db: opts.db,
      from: opts.from,
      to: opts.to,
      minHistoryDays: opts.minHistoryDays,
      universeRaw: opts.universe,
      benchSymbolUpper: NIFTY_BENCHMARK_SYMBOL.toUpperCase(),
      extendedCalendarDaysBack: 450,
    });
    regimeProxyByDate = built.map;
    universeForStrategies = built.filteredUniverse;
  }

  const base = {
    from: opts.from,
    to: opts.to,
    costBpsRoundTrip: opts.costBpsRoundTrip,
    minHistoryDays: opts.minHistoryDays,
    initialMultiplier: opts.initialMultiplier,
    tightenedMultiplier: opts.tightenedMultiplier,
    lockInThresholdPct: opts.lockInThresholdPct,
    universe: universeForStrategies,
    db: opts.db,
    regimeSource,
    regimeProxyByDate,
  };

  if (opts.strategy === 'momentum-mf' || opts.strategy === 'all') {
    byStrategy.momentum_mf = runMomentumMfBacktest(base);
  }
  if (opts.strategy === 'ai-pick' || opts.strategy === 'all') {
    byStrategy.ai_pick = runAiPickBacktest(base);
  }

  const rawUniverse = opts.universe ?? [];
  const universeUsed =
    rawUniverse.length > 0
      ? filterOptionAUniverse(rawUniverse, opts.from, opts.to, opts.minHistoryDays, opts.db)
      : [];

  return { byStrategy, universeUsed };
}
