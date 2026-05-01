/**
 * Sector label for portfolio risk rollup: config overrides, instrument heuristics,
 * then optional DB sector (from Yahoo `quoteSummary` cached in `symbols` during ingest).
 */

import { heuristicInstrumentSector } from '../market/instrument-sector-heuristic.js';

/**
 * @param dbSector - From `symbols.sector` when ingest has populated it (Yahoo); optional.
 */
export function classifySector(
  symbol: string,
  explicitMap: Record<string, string>,
  dbSector?: string | null,
): string {
  const s = symbol.toUpperCase();
  if (explicitMap[s]) return explicitMap[s];

  const heuristic = heuristicInstrumentSector(s);
  if (heuristic) return heuristic;

  const fromDb = dbSector?.trim();
  if (fromDb) return fromDb;

  return 'Unknown';
}
