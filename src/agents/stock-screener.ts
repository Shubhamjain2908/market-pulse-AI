/**
 * Stock Screener agent. Runs the configured screens against the watchlist
 * for a given trading date AND scans for threshold-based alerts.
 *
 * Returns a summary suitable for the daily run-all log line; raw matches
 * are persisted to the `screens` table and alerts to `alerts`.
 */

import { runAlertScan, runScreenEngine } from '../analysers/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';

const log = child({ component: 'stock-screener' });

export interface ScreenRunOptions {
  date?: string;
  /** Restrict to a single screen by name. */
  screen?: string;
}

export interface ScreenRunResult {
  date: string;
  screensApplied: string[];
  matchesByScreen: Record<string, number>;
  partialByScreen: Record<string, number>;
  alertsCount: number;
}

export async function runStockScreener(opts: ScreenRunOptions = {}): Promise<ScreenRunResult> {
  const date = opts.date ?? isoDateIst();

  const engineResult = runScreenEngine({ date, onlyScreen: opts.screen });
  const alertResult = runAlertScan({ date });

  log.info(
    {
      date,
      screens: engineResult.screensApplied,
      matches: engineResult.matchesByScreen,
      partial: engineResult.partialByScreen,
      alerts: alertResult.alerts.length,
    },
    'screening complete',
  );

  return {
    date,
    screensApplied: engineResult.screensApplied,
    matchesByScreen: engineResult.matchesByScreen,
    partialByScreen: engineResult.partialByScreen,
    alertsCount: alertResult.alerts.length,
  };
}
