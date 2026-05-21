/**
 * Option A backtest engine — thin orchestration over strategy modules.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { runAiPickBacktest } from './strategies/ai-pick.js';
import { runMomentumMfBacktest } from './strategies/momentum-mf.js';
import type { ClosedSimTrade } from './types.js';

export type OptionAStrategy = 'momentum-mf' | 'ai-pick' | 'all';

export interface RunOptionAEngineOpts {
  strategy: OptionAStrategy;
  from: string;
  to: string;
  costBpsRoundTrip: number;
  minHistoryDays: number;
  universe?: string[];
  db: DatabaseType;
}

export interface RunOptionAEngineResult {
  byStrategy: {
    momentum_mf?: ClosedSimTrade[];
    ai_pick?: ClosedSimTrade[];
  };
}

export function runOptionAEngine(opts: RunOptionAEngineOpts): RunOptionAEngineResult {
  const byStrategy: RunOptionAEngineResult['byStrategy'] = {};
  const base = {
    from: opts.from,
    to: opts.to,
    costBpsRoundTrip: opts.costBpsRoundTrip,
    minHistoryDays: opts.minHistoryDays,
    universe: opts.universe,
    db: opts.db,
  };

  if (opts.strategy === 'momentum-mf' || opts.strategy === 'all') {
    byStrategy.momentum_mf = runMomentumMfBacktest(base);
  }
  if (opts.strategy === 'ai-pick' || opts.strategy === 'all') {
    byStrategy.ai_pick = runAiPickBacktest(base);
  }
  return { byStrategy };
}
