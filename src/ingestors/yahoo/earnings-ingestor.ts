/**
 * Yahoo Finance `quoteSummary` earnings module → `earnings_calendar` (next IST earnings date only).
 * Fetch failures and missing/stale dates clear the symbol row (fail-open for momentum blackout).
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import YahooFinance from 'yahoo-finance2';
import { replaceMomentumEarningsCalendarForSymbol } from '../../db/momentum-queries.js';
import { child } from '../../logger.js';
import { BENCHMARK_QUOTE_SYMBOLS, GLOBAL_MACRO_QUOTE_SYMBOLS } from '../../market/benchmarks.js';
import { heuristicInstrumentSector } from '../../market/instrument-sector-heuristic.js';
import { toYahooFinanceTicker } from '../../market/yahoo-ticker.js';
import { isoDateIst } from '../base/dates.js';

const log = child({ component: 'yahoo-earnings-ingestor' });

export const YAHOO_EARNINGS_CALENDAR_SOURCE = 'yahoo_quote_summary';

const MACRO_SKIP = new Set<string>([...BENCHMARK_QUOTE_SYMBOLS, ...GLOBAL_MACRO_QUOTE_SYMBOLS]);

export interface SyncMomentumEarningsCalendarOptions {
  /** IST calendar date used to pick the first earnings date >= this day (default: today IST). */
  refDate?: string;
  delayMs?: number;
}

export interface SyncMomentumEarningsCalendarResult {
  symbolsProcessed: number;
  skippedMacOrHeuristic: number;
  rowsWritten: number;
  clearedNoUpcoming: number;
  fetchFailed: number;
}

/**
 * From `earnings.earningsChart.earningsDate` (ISO timestamps), pick the earliest date
 * whose IST calendar day is on or after `refIso`.
 */
export function pickFirstFutureEarningsDateIso(
  earningsDateRaw: unknown,
  refIso: string,
): string | null {
  if (!Array.isArray(earningsDateRaw)) return null;
  let best: string | null = null;
  for (const raw of earningsDateRaw) {
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) continue;
    const iso = isoDateIst(d);
    if (iso < refIso) continue;
    if (best === null || iso < best) best = iso;
  }
  return best;
}

export async function syncMomentumEarningsCalendarFromYahoo(
  symbols: string[],
  db: DatabaseType,
  opts: SyncMomentumEarningsCalendarOptions = {},
): Promise<SyncMomentumEarningsCalendarResult> {
  const refIso = opts.refDate ?? isoDateIst();
  const delayMs = opts.delayMs ?? 120;
  const client = new YahooFinance();

  const result: SyncMomentumEarningsCalendarResult = {
    symbolsProcessed: 0,
    skippedMacOrHeuristic: 0,
    rowsWritten: 0,
    clearedNoUpcoming: 0,
    fetchFailed: 0,
  };

  const seen = new Set<string>();

  for (const raw of symbols) {
    const sym = raw.toUpperCase();
    if (seen.has(sym)) continue;
    seen.add(sym);

    if (MACRO_SKIP.has(sym) || heuristicInstrumentSector(sym)) {
      result.skippedMacOrHeuristic++;
      continue;
    }

    result.symbolsProcessed++;
    const yTicker = toYahooFinanceTicker(sym);
    const fetchedAt = new Date().toISOString();

    try {
      const r = await client.quoteSummary(yTicker, { modules: ['earnings'] });
      const dates = r.earnings?.earningsChart?.earningsDate;
      const nextIso = pickFirstFutureEarningsDateIso(dates ?? null, refIso);

      if (nextIso) {
        replaceMomentumEarningsCalendarForSymbol(sym, nextIso, db, {
          source: YAHOO_EARNINGS_CALENDAR_SOURCE,
          fetchedAt,
        });
        result.rowsWritten++;
      } else {
        replaceMomentumEarningsCalendarForSymbol(sym, null, db, {
          source: YAHOO_EARNINGS_CALENDAR_SOURCE,
          fetchedAt,
        });
        result.clearedNoUpcoming++;
      }
    } catch (err) {
      result.fetchFailed++;
      replaceMomentumEarningsCalendarForSymbol(sym, null, db, {
        source: YAHOO_EARNINGS_CALENDAR_SOURCE,
        fetchedAt,
      });
      log.warn(
        { symbol: sym, yTicker, err: (err as Error).message },
        'yahoo earnings fetch failed; cleared calendar row (fail-open)',
      );
    }

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  log.info(result, 'momentum earnings calendar sync done');
  return result;
}
