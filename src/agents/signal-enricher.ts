/**
 * Signal Enricher agent. Reads recent quotes from SQLite for the ingest
 * universe (watchlist + holdings + benchmarks unless symbols are passed),
 * runs the technical indicators, then momentum factors for the momentum universe.
 */

import { getMomentumUniverseSymbols } from '../config/loaders.js';
import { getDb } from '../db/index.js';
import { type EnricherStats, TechnicalEnricher } from '../enrichers/index.js';
import { enrichMomentumSignals } from '../enrichers/momentum-signals.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';
import { defaultIngestSymbolUniverse } from '../market/ingest-symbols.js';

const log = child({ component: 'signal-enricher' });

export interface EnrichRunOptions {
  date?: string;
  symbols?: string[];
}

export interface EnrichRunResult extends EnricherStats {
  date: string;
  momentumBlackoutSignalsWritten: number;
  momentumFactorSignalsWritten: number;
}

export async function runSignalEnricher(opts: EnrichRunOptions = {}): Promise<EnrichRunResult> {
  const date = opts.date ?? isoDateIst();
  const symbols = opts.symbols
    ? opts.symbols.map((s) => s.toUpperCase())
    : defaultIngestSymbolUniverse(getDb());

  log.info({ date, symbols: symbols.length }, 'starting technical enrichment');
  const enricher = new TechnicalEnricher({ asOfDate: date });
  const stats = enricher.enrich(symbols);
  const db = getDb();

  let momentumBlackoutSignalsWritten = 0;
  let momentumFactorSignalsWritten = 0;

  try {
    const momentumUniverse = getMomentumUniverseSymbols({ fresh: true });
    const momSyms = opts.symbols?.length
      ? momentumUniverse.filter((s) => symbols.includes(s))
      : momentumUniverse;
    if (momSyms.length > 0) {
      const m = enrichMomentumSignals(date, momSyms, db);
      momentumBlackoutSignalsWritten = m.blackoutRowsWritten;
      momentumFactorSignalsWritten = m.factorSignalRowsWritten;
    }
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'momentum signals skipped (missing momentum-universe.json or momentum-config.json)',
    );
  }

  return {
    date,
    ...stats,
    momentumBlackoutSignalsWritten,
    momentumFactorSignalsWritten,
  };
}
