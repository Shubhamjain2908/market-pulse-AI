/**
 * Stock Screener agent. Phase 0 placeholder.
 */

import { logger } from '../logger.js';

export interface ScreenRunOptions {
  date?: string;
  /** Restrict to a single screen by name. */
  screen?: string;
}

export interface ScreenRunResult {
  screensApplied: string[];
  matchesByScreen: Record<string, number>;
}

export async function runStockScreener(opts: ScreenRunOptions = {}): Promise<ScreenRunResult> {
  logger.info({ phase: 'screen', screen: opts.screen ?? 'all' }, 'screener placeholder ran');
  return { screensApplied: [], matchesByScreen: {} };
}
