/**
 * Optional JSON run summary next to briefings (ops / audit).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config/env.js';

export interface DailyRunSummaryV1 {
  schemaVersion: 1;
  generatedAt: string;
  date: string;
  holidayMode: boolean;
  marketClosureLabel?: string;
  delivery: string;
  counts: {
    alerts: number;
    screenMatchSymbols: number;
    news: number;
    theses: number;
    portfolioHoldings: number;
  };
  thesisRun?: {
    generated: number;
    failed: number;
    candidateCount: number;
    eligibleUniverseSize: number;
    watchlistSize: number;
  };
  hasMoodNarrative: boolean;
}

export function maybeWriteDailyRunSummary(payload: DailyRunSummaryV1): void {
  if (config.BRIEFING_RUN_SUMMARY_JSON !== '1') return;
  const dir = config.BRIEFING_OUTPUT_DIR;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `run-summary-${payload.date}.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
