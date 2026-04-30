/**
 * Daily Ingestor agent. Phase 0 placeholder: returns a no-op result so the
 * CLI can be wired end-to-end. Real implementation in Phase 1 - see
 * `docs/plan.md` (or the spec in `new.cjs`) for the contract.
 */

import { logger } from '../logger.js';

export interface IngestRunOptions {
  date?: string;
  symbols?: string[];
}

export interface IngestRunResult {
  ingestors: string[];
  quotesWritten: number;
  fundamentalsWritten: number;
  newsWritten: number;
  fiiDiiWritten: number;
  failures: { ingestor: string; reason: string }[];
}

export async function runDailyIngestor(opts: IngestRunOptions = {}): Promise<IngestRunResult> {
  logger.info({ phase: 'ingest', date: opts.date ?? 'today' }, 'ingestor placeholder ran');
  return {
    ingestors: [],
    quotesWritten: 0,
    fundamentalsWritten: 0,
    newsWritten: 0,
    fiiDiiWritten: 0,
    failures: [],
  };
}
