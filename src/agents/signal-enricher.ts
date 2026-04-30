/**
 * Signal Enricher agent. Reads recent quotes from SQLite for the watchlist
 * (and any extra symbols), runs the technical indicators, and writes the
 * resulting signals back to the DB.
 */

import { loadWatchlist } from '../config/loaders.js';
import { type EnricherStats, TechnicalEnricher } from '../enrichers/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';

const log = child({ component: 'signal-enricher' });

export interface EnrichRunOptions {
  date?: string;
  symbols?: string[];
}

export interface EnrichRunResult extends EnricherStats {
  date: string;
}

export async function runSignalEnricher(opts: EnrichRunOptions = {}): Promise<EnrichRunResult> {
  const date = opts.date ?? isoDateIst();
  const symbols = (opts.symbols ?? loadWatchlist().symbols).map((s) => s.toUpperCase());

  log.info({ date, symbols: symbols.length }, 'starting technical enrichment');
  const enricher = new TechnicalEnricher({ asOfDate: date });
  const stats = enricher.enrich(symbols);

  return { date, ...stats };
}
