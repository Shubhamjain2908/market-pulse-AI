/**
 * Fetches Yahoo Finance sector/industry for equities and caches them in `symbols`.
 * Skips benchmark/macro tickers and instruments matched by {@link heuristicInstrumentSector}.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import YahooFinance from 'yahoo-finance2';
import { upsertSymbolMetadata } from '../db/queries.js';
import { child } from '../logger.js';
import { BENCHMARK_QUOTE_SYMBOLS, GLOBAL_MACRO_QUOTE_SYMBOLS } from './benchmarks.js';
import { heuristicInstrumentSector } from './instrument-sector-heuristic.js';
import { toYahooFinanceTicker } from './yahoo-ticker.js';

const log = child({ component: 'yahoo-sectors' });

const MACRO_SKIP = new Set<string>([...BENCHMARK_QUOTE_SYMBOLS, ...GLOBAL_MACRO_QUOTE_SYMBOLS]);

export interface SyncSymbolSectorsResult {
  written: number;
  skipped: number;
  failed: string[];
}

/**
 * For each symbol, if we don't already have a sector (unless `force`), calls Yahoo
 * `quoteSummary` and stores `sector` / `industry` / `name` on `symbols`.
 */
function pickOptionalString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export async function syncSymbolSectorsFromYahoo(
  symbols: string[],
  db: DatabaseType,
  opts: { delayMs?: number; force?: boolean } = {},
): Promise<SyncSymbolSectorsResult> {
  const delayMs = opts.delayMs ?? 120;
  const client = new YahooFinance();
  const failed: string[] = [];
  let written = 0;
  let skipped = 0;

  const seen = new Set<string>();
  const stmt = db.prepare('SELECT sector FROM symbols WHERE symbol = ?') as {
    get: (sym: string) => { sector?: string | null } | undefined;
  };

  for (const raw of symbols) {
    const sym = raw.toUpperCase();
    if (seen.has(sym)) continue;
    seen.add(sym);

    if (MACRO_SKIP.has(sym)) {
      skipped++;
      continue;
    }
    if (heuristicInstrumentSector(sym)) {
      skipped++;
      continue;
    }

    if (!opts.force) {
      const row = stmt.get(sym);
      const existing = row?.sector?.trim();
      if (existing) {
        skipped++;
        continue;
      }
    }

    const yTicker = toYahooFinanceTicker(sym);
    try {
      const r = await client.quoteSummary(yTicker, {
        modules: ['assetProfile', 'summaryProfile'],
      });
      const ap = r.assetProfile;
      const sp = r.summaryProfile;
      const sector =
        pickOptionalString(ap?.sector) ??
        pickOptionalString(ap?.sectorDisp) ??
        pickOptionalString(sp?.sector) ??
        pickOptionalString(sp?.industryDisp);
      const industry = pickOptionalString(ap?.industry) ?? pickOptionalString(sp?.industry);
      const name =
        pickOptionalString(ap?.longName) ??
        pickOptionalString(ap?.name) ??
        pickOptionalString(sp?.longName) ??
        pickOptionalString(sp?.name);

      if (sector) {
        upsertSymbolMetadata([{ symbol: sym, sector, industry, name }], db);
        written++;
      } else {
        skipped++;
        log.debug({ symbol: sym, yTicker }, 'yahoo quoteSummary had no sector; skipping DB write');
      }
    } catch (err) {
      failed.push(sym);
      log.warn({ symbol: sym, yTicker, err: (err as Error).message }, 'yahoo sector fetch failed');
    }

    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  log.info({ written, skipped, failed: failed.length }, 'symbol sector metadata sync done');
  return { written, skipped, failed };
}
