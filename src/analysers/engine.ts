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
import { getDb } from '../db/index.js';
import { upsertScreenResults } from '../db/queries.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';
import type { ScreenDefinition } from '../types/domain.js';
import { type ScreenEvaluation, evaluateScreen, toScreenResult } from './evaluator.js';
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
}

export interface ScreenEngineResult {
  date: string;
  screensApplied: string[];
  /** Total candidates per screen that matched ALL criteria. */
  matchesByScreen: Record<string, number>;
  /** Per-screen partial matches (score >= threshold) — diagnostic. */
  partialByScreen: Record<string, number>;
  /** Full evaluation list for callers that need raw data. */
  evaluations: ScreenEvaluation[];
}

/** Score >= this is considered a "near match" worth surfacing for diagnostics. */
const PARTIAL_MATCH_THRESHOLD = 0.6;

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
    const passing = evaluations.filter((e) => e.passed);
    const written = upsertScreenResults(passing.map(toScreenResult), db);
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
