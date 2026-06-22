/**
 * Screen engine. Loads screen definitions from config (or accepts an
 * explicit list), evaluates each one against every watchlist symbol on a
 * given date using the provided SignalProvider, and persists the results
 * to the `screens` table.
 *
 * Engine is decoupled from CLI/agent concerns — call sites (the daily
 * agent, the backtester) wire in their own provider, screens, and date.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { loadScreens, loadWatchlist } from '../config/loaders.js';
import { getDb, getSizeMultiplier, isStrategyAllowed } from '../db/index.js';
import { upsertScreenResults } from '../db/queries.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';
import type { ScreenDefinition, ScreenResult } from '../types/domain.js';
import type { Regime } from '../types/regime.js';
import { evaluateScreen, type ScreenEvaluation, toScreenResult } from './evaluator.js';
import type { QualityGarpFunnelCounts } from './quality-garp.js';
import { DbSignalProvider, type SignalProvider } from './signal-provider.js';

const log = child({ component: 'screen-engine' });

export interface ScreenEngineOptions {
  date?: string;
  /** Override the watchlist (testing/backtest). */
  symbols?: string[];
  /** Override the screen list (e.g. run only one screen). */
  screens?: ScreenDefinition[];
  /** Restrict to a single screen by name. */
  onlyScreen?: string;
  /** Inject a custom SignalProvider — defaults to DbSignalProvider. */
  provider?: SignalProvider;
  /** Persist results to the `screens` table. Default true. */
  persist?: boolean;
  /**
   * When set, skips screens disallowed for this regime (`regime_strategy_gate`)
   * and adds `__regime_meta` to persisted `matched_criteria` JSON for audit.
   */
  regime?: Regime;
}

export interface ScreenEngineResult {
  date: string;
  screensApplied: string[];
  /** Total candidates per screen that matched ALL criteria. */
  matchesByScreen: Record<string, number>;
  /** Per-screen partial matches (score >= threshold) — diagnostic. */
  partialByScreen: Record<string, number>;
  /** Per-screen gate elimination counts (quality_garp only). */
  funnelByScreen?: Record<string, QualityGarpFunnelCounts>;
  /** Full evaluation list for callers that need raw data. */
  evaluations: ScreenEvaluation[];
}

/** Score >= this is considered a "near match" worth surfacing for diagnostics. */
const PARTIAL_MATCH_THRESHOLD = 0.6;

function applyRegimeMetaToResult(
  row: ScreenResult,
  regime: Regime,
  db: DatabaseType,
): ScreenResult {
  const criteria = Array.isArray(row.matchedCriteria)
    ? row.matchedCriteria
    : row.matchedCriteria.criteria;
  const mult = getSizeMultiplier(row.screenName, regime, db);
  return {
    ...row,
    matchedCriteria: {
      criteria,
      __regime_meta: {
        regime,
        sizeMultiplier: mult,
        strategyId: row.screenName,
      },
    },
  };
}

export function runScreenEngine(
  opts: ScreenEngineOptions = {},
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

  const evaluations: ScreenEvaluation[] = [];
  const matchesByScreen: Record<string, number> = {};
  const partialByScreen: Record<string, number> = {};

  for (const screen of screens) {
    if (opts.regime != null && !isStrategyAllowed(screen.name, opts.regime, db)) {
      log.info(
        { screen: screen.name, regime: opts.regime },
        '[GATED] screen skipped by regime_strategy_gate',
      );
      matchesByScreen[screen.name] = 0;
      partialByScreen[screen.name] = 0;
      continue;
    }

    let passed = 0;
    let partial = 0;
    for (const symbol of symbols) {
      const evaluation = evaluateScreen(screen, symbol, date, provider);
      evaluations.push(evaluation);
      if (evaluation.passed) passed++;
      else if (evaluation.score >= PARTIAL_MATCH_THRESHOLD) partial++;
    }
    matchesByScreen[screen.name] = passed;
    partialByScreen[screen.name] = partial;
  }

  if (persist) {
    const passing = evaluations
      .filter((e) => e.passed)
      .map((e) => {
        const base = toScreenResult(e);
        if (opts.regime == null) return base;
        return applyRegimeMetaToResult(base, opts.regime, db);
      });
    const written = upsertScreenResults(passing, db);
    log.info(
      {
        date,
        screens: screens.length,
        symbols: symbols.length,
        evaluations: evaluations.length,
        matched: passing.length,
        written,
      },
      'screen engine run complete',
    );
  } else {
    log.debug(
      { date, screens: screens.length, symbols: symbols.length, evaluations: evaluations.length },
      'screen engine evaluated (persist=false)',
    );
  }

  return {
    date,
    screensApplied: screens.map((s) => s.name),
    matchesByScreen,
    partialByScreen,
    evaluations,
  };
}
