/**
 * Signal Enricher agent. Phase 0 placeholder.
 */

import { logger } from '../logger.js';

export interface EnrichRunOptions {
  date?: string;
  symbols?: string[];
}

export interface EnrichRunResult {
  signalsWritten: number;
  symbolsProcessed: number;
}

export async function runSignalEnricher(opts: EnrichRunOptions = {}): Promise<EnrichRunResult> {
  logger.info({ phase: 'enrich', date: opts.date ?? 'today' }, 'enricher placeholder ran');
  return { signalsWritten: 0, symbolsProcessed: 0 };
}
