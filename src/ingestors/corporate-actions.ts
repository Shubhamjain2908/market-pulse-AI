/**
 * Yahoo Finance split events (via `chart` `events: 'split'`) → `corporate_actions`
 * + nominal adjustment for OPEN `paper_trades`.
 *
 * Note: `yahoo-finance2` v3.14 does not allow `splitHistory` in `quoteSummary` module
 * options (schema rejects it). Yahoo exposes the same ratios on `chart` split events
 * (including bonus-style ratios encoded as split numerators/denominators).
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import YahooFinance from 'yahoo-finance2';

import { child } from '../logger.js';
import { toYahooFinanceTicker } from '../market/yahoo-ticker.js';
import { isoDateIst, parseIsoDate } from './base/dates.js';

const log = child({ component: 'corporate-actions' });

export const CORPORATE_ACTION_SOURCE_YAHOO = 'yahoo';
export const CORPORATE_ACTION_TYPE_SPLIT = 'split';

export interface YahooSplitHistoryRow {
  date: unknown;
  numerator: unknown;
  denominator: unknown;
}

export interface ApplyCorporateActionsFromYahooSplitsOptions {
  refDate?: string;
  delayMs?: number;
  /** Test seam: bypass Yahoo and return raw split rows for a Yahoo ticker. */
  fetchSplitHistory?: (yTicker: string, refIso: string) => Promise<YahooSplitHistoryRow[]>;
}

export interface ApplyCorporateActionsFromYahooSplitsResult {
  symbolsChecked: number;
  splitsApplied: number;
  fetchFailed: number;
}

function toUnixMs(raw: unknown): number | null {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw.getTime();
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === 'string') {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.getTime();
    const n = Number(raw);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  }
  return null;
}

function lowerExclusiveIsoFromRef(refIso: string): string {
  const ref = parseIsoDate(refIso);
  const t = ref.getTime() - 5 * 24 * 60 * 60 * 1000;
  return isoDateIst(new Date(t));
}

function chartResultToSplitRows(chart: unknown): YahooSplitHistoryRow[] {
  if (!chart || typeof chart !== 'object') return [];
  const splits = (chart as { events?: { splits?: unknown } }).events?.splits;
  if (!splits) return [];
  if (Array.isArray(splits)) {
    return splits as YahooSplitHistoryRow[];
  }
  if (typeof splits === 'object') {
    return Object.values(splits as Record<string, YahooSplitHistoryRow>);
  }
  return [];
}

async function defaultFetchSplitHistory(
  yTicker: string,
  refIso: string,
): Promise<YahooSplitHistoryRow[]> {
  const client = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  const ref = parseIsoDate(refIso);
  const period2 = new Date(ref.getTime() + 2 * 24 * 60 * 60 * 1000);
  const period1 = new Date(ref.getTime() - 20 * 24 * 60 * 60 * 1000);
  const data = await client.chart(
    yTicker,
    { period1, period2, interval: '1d', events: 'split' },
    { validateResult: false },
  );
  return chartResultToSplitRows(data);
}

/**
 * For each OPEN paper symbol: pull recent Yahoo split events, record `corporate_actions`,
 * divide nominal prices on OPEN rows, append SPLIT audit to `trailing_stop_log` once per row.
 */
export async function applyCorporateActionsFromYahooSplits(
  db: DatabaseType,
  opts: ApplyCorporateActionsFromYahooSplitsOptions = {},
): Promise<ApplyCorporateActionsFromYahooSplitsResult> {
  const refIso = opts.refDate ?? isoDateIst();
  const delayMs = opts.delayMs ?? 120;
  const lowerExclusive = lowerExclusiveIsoFromRef(refIso);
  const fetchFn =
    opts.fetchSplitHistory ??
    ((ticker: string, ref: string) => defaultFetchSplitHistory(ticker, ref));

  const symbols = db
    .prepare(`SELECT DISTINCT symbol FROM paper_trades WHERE status = 'OPEN'`)
    .all() as Array<{ symbol: string }>;

  const runStats: ApplyCorporateActionsFromYahooSplitsResult = {
    symbolsChecked: 0,
    splitsApplied: 0,
    fetchFailed: 0,
  };

  const insertCa = db.prepare(
    `INSERT OR IGNORE INTO corporate_actions (symbol, ex_date, type, factor, source)
     VALUES (@symbol, @ex_date, @type, @factor, @source)`,
  );

  const updatePaper = db.prepare(`
    UPDATE paper_trades
    SET entry_price = entry_price / @factor,
        stop_loss = stop_loss / @factor,
        target = target / @factor,
        highest_close_since_entry = CASE
          WHEN highest_close_since_entry IS NOT NULL THEN highest_close_since_entry / @factor
          ELSE NULL
        END,
        atr14_at_entry = CASE
          WHEN atr14_at_entry IS NOT NULL THEN atr14_at_entry / @factor
          ELSE NULL
        END
    WHERE symbol = @symbol AND status = 'OPEN'
  `);

  const listOpenTradeIds = db.prepare(
    `SELECT id FROM paper_trades WHERE symbol = ? AND status = 'OPEN'`,
  );

  const appendLogNotes = db.prepare(`
    UPDATE trailing_stop_log
    SET notes = CASE
      WHEN notes IS NULL THEN @suffix
      ELSE notes || ' ' || @suffix
    END
    WHERE trade_id = @trade_id
      AND (notes IS NULL OR notes NOT LIKE '%SPLIT%')
  `);

  for (let i = 0; i < symbols.length; i++) {
    const row = symbols[i];
    if (!row) continue;
    const symbol = row.symbol;
    runStats.symbolsChecked++;
    const yTicker = toYahooFinanceTicker(symbol);

    let rows: YahooSplitHistoryRow[];
    try {
      rows = await fetchFn(yTicker, refIso);
    } catch (err) {
      runStats.fetchFailed++;
      log.warn({ symbol, yTicker, err: (err as Error).message }, 'yahoo split events fetch failed');
      continue;
    }

    const candidates: Array<{
      exDate: string;
      factor: number;
      numerator: number;
      denominator: number;
    }> = [];

    for (const ev of rows) {
      const ms = toUnixMs(ev.date);
      if (ms == null) continue;
      const exDate = isoDateIst(new Date(ms));
      if (!(exDate > lowerExclusive && exDate <= refIso)) continue;

      const num = typeof ev.numerator === 'number' ? ev.numerator : Number(ev.numerator);
      const den = typeof ev.denominator === 'number' ? ev.denominator : Number(ev.denominator);
      if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) continue;
      const factor = num / den;
      if (!Number.isFinite(factor) || factor <= 0) continue;

      candidates.push({ exDate, factor, numerator: num, denominator: den });
    }

    candidates.sort((a, b) => (a.exDate < b.exDate ? -1 : a.exDate > b.exDate ? 1 : 0));

    for (const c of candidates) {
      const suffix = `SPLIT ${c.numerator}:${c.denominator} effective ${c.exDate}. Pre-split nominal values retained for audit.`;

      const tx = db.transaction(() => {
        const insRes = insertCa.run({
          symbol,
          ex_date: c.exDate,
          type: CORPORATE_ACTION_TYPE_SPLIT,
          factor: c.factor,
          source: CORPORATE_ACTION_SOURCE_YAHOO,
        });
        if (insRes.changes === 0) return;

        updatePaper.run({ symbol, factor: c.factor });

        const tradeIds = listOpenTradeIds.all(symbol) as Array<{ id: number }>;
        for (const t of tradeIds) {
          appendLogNotes.run({ trade_id: t.id, suffix });
        }

        runStats.splitsApplied++;
      });

      tx();
    }

    if (i + 1 < symbols.length && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  log.info(runStats, 'corporate actions from Yahoo split events complete');
  return runStats;
}
