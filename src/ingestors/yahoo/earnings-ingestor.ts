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
import { isYahooMissingSymbolError } from '../../market/yahoo-errors.js';
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

function toDateOrNull(raw: unknown): Date | null {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }
  if (typeof raw === 'string' || typeof raw === 'number') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
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
    const d = toDateOrNull(raw);
    if (d == null) continue;
    const iso = isoDateIst(d);
    if (iso < refIso) continue;
    if (best === null || iso < best) best = iso;
  }
  return best;
}

/**
 * Merge Yahoo earnings timestamps from `earnings` and `calendarEvents` modules.
 * Indian listings often populate `calendarEvents` when `earningsChart.earningsDate` is empty.
 */
export function mergeQuoteSummaryEarningsDates(summary: unknown): unknown[] {
  if (!summary || typeof summary !== 'object') return [];
  const s = summary as {
    earnings?: { earningsChart?: { earningsDate?: unknown } };
    calendarEvents?: { earnings?: { earningsDate?: unknown } };
  };
  const fromChart = s.earnings?.earningsChart?.earningsDate;
  const fromCalendar = s.calendarEvents?.earnings?.earningsDate;
  const out: unknown[] = [];
  if (Array.isArray(fromChart)) out.push(...fromChart);
  if (Array.isArray(fromCalendar)) out.push(...fromCalendar);
  return out;
}

export async function syncMomentumEarningsCalendarFromYahoo(
  symbols: string[],
  db: DatabaseType,
  opts: SyncMomentumEarningsCalendarOptions = {},
): Promise<SyncMomentumEarningsCalendarResult> {
  const refIso = opts.refDate ?? isoDateIst();
  const delayMs = opts.delayMs ?? 120;
  const client = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

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
      // Yahoo often omits `estimate` on quarterly rows → schema validation fails though
      // `earningsDate` is present. We only need dates; skip strict result validation.
      const r = await client.quoteSummary(
        yTicker,
        { modules: ['earnings', 'calendarEvents'] },
        { validateResult: false },
      );
      const merged = mergeQuoteSummaryEarningsDates(r);
      const nextIso = pickFirstFutureEarningsDateIso(merged, refIso);

      if (nextIso) {
        replaceMomentumEarningsCalendarForSymbol(db, sym, [
          {
            expectedDate: nextIso,
            source: YAHOO_EARNINGS_CALENDAR_SOURCE,
            fetchedAt,
          },
        ]);
        result.rowsWritten++;
      } else {
        replaceMomentumEarningsCalendarForSymbol(db, sym, []);
        result.clearedNoUpcoming++;
      }
    } catch (err) {
      result.fetchFailed++;
      replaceMomentumEarningsCalendarForSymbol(db, sym, []);
      if (isYahooMissingSymbolError(err)) {
        log.debug(
          { symbol: sym, yTicker, err: (err as Error).message },
          'yahoo earnings unavailable for symbol; cleared calendar row (fail-open)',
        );
        continue;
      }
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
