/**
 * SignalProvider abstracts "give me the value of signal X for symbol Y on
 * date Z". Screens reference signals by flat name (e.g. "rsi_14",
 * "debt_to_equity", "fii_net_streak_days") and don't care which underlying
 * table holds them.
 *
 * The default `DbSignalProvider` resolves names from three sources:
 *   1. `signals` table — technical indicators emitted by TechnicalEnricher
 *      (rsi_14, sma_50, close, volume_ratio_20d, pct_from_52w_high, ...)
 *   2. `fundamentals` table — most recent fundamentals row (pe, pb, peg,
 *      roe, roce, debt_to_equity, revenue_growth_yoy, profit_growth_yoy,
 *      promoter_holding_pct, promoter_holding_change_qoq, dividend_yield,
 *      market_cap, dividend_yield)
 *   3. Computed flow signals derived on the fly from `fii_dii`:
 *      - fii_net (today)
 *      - dii_net (today)
 *      - fii_net_5d_sum (sum of last 5 sessions)
 *      - dii_net_5d_sum (same for DIIs)
 *      - fii_net_streak_days (consecutive sessions with FII net > 0)
 *
 * Per-symbol-per-date data is loaded once and cached, so a screen with N
 * criteria triggers at most one DB hit per source.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/index.js';

export interface SignalProvider {
  /** Returns the value, or null if the signal isn't available. */
  get(symbol: string, date: string, signal: string): number | null;
}

const FUNDAMENTAL_COLUMNS = new Set([
  'market_cap',
  'pe',
  'pb',
  'peg',
  'roe',
  'roce',
  'revenue_growth_yoy',
  'profit_growth_yoy',
  'debt_to_equity',
  'promoter_holding_pct',
  'promoter_holding_change_qoq',
  'dividend_yield',
]);

const FLOW_SIGNALS = new Set([
  'fii_net',
  'dii_net',
  'fii_net_5d_sum',
  'dii_net_5d_sum',
  'fii_net_streak_days',
  'dii_net_streak_days',
]);

export class DbSignalProvider implements SignalProvider {
  private readonly technical = new Map<string, Map<string, number>>();
  private readonly fundamentals = new Map<string, Map<string, number>>();
  private readonly flow = new Map<string, Map<string, number>>();

  constructor(private readonly db: DatabaseType = getDb()) {}

  get(symbol: string, date: string, signal: string): number | null {
    if (FUNDAMENTAL_COLUMNS.has(signal)) {
      return this.lookupFundamental(symbol, signal);
    }
    if (FLOW_SIGNALS.has(signal)) {
      return this.lookupFlow(date, signal);
    }
    return this.lookupTechnical(symbol, date, signal);
  }

  // -------------------------------------------------------------------------
  // Technical signals (signals table)
  // -------------------------------------------------------------------------

  private lookupTechnical(symbol: string, date: string, signal: string): number | null {
    const row = this.loadTechnical(symbol, date);
    const v = row.get(signal);
    return v == null ? null : v;
  }

  private loadTechnical(symbol: string, date: string): Map<string, number> {
    const key = `${symbol}|${date}`;
    const cached = this.technical.get(key);
    if (cached) return cached;

    const rows = this.db
      .prepare(`
        SELECT name, value FROM signals
        WHERE symbol = ? AND date <= ?
          AND date = (SELECT MAX(date) FROM signals s2
                      WHERE s2.symbol = signals.symbol AND s2.date <= ?)
      `)
      .all(symbol, date, date) as Array<{ name: string; value: number }>;

    const map = new Map<string, number>();
    for (const r of rows) map.set(r.name, r.value);
    this.technical.set(key, map);
    return map;
  }

  // -------------------------------------------------------------------------
  // Fundamentals
  // -------------------------------------------------------------------------

  private lookupFundamental(symbol: string, column: string): number | null {
    const row = this.loadFundamentals(symbol);
    const v = row.get(column);
    return v == null ? null : v;
  }

  private loadFundamentals(symbol: string): Map<string, number> {
    const cached = this.fundamentals.get(symbol);
    if (cached) return cached;

    const row = this.db
      .prepare(`
        SELECT * FROM fundamentals WHERE symbol = ?
        ORDER BY as_of DESC LIMIT 1
      `)
      .get(symbol) as Record<string, unknown> | undefined;

    const map = new Map<string, number>();
    if (row) {
      for (const col of FUNDAMENTAL_COLUMNS) {
        const v = row[col];
        if (typeof v === 'number' && Number.isFinite(v)) map.set(col, v);
      }
    }
    this.fundamentals.set(symbol, map);
    return map;
  }

  // -------------------------------------------------------------------------
  // Flow signals (derived from fii_dii table)
  // -------------------------------------------------------------------------

  private lookupFlow(date: string, signal: string): number | null {
    const row = this.loadFlow(date);
    const v = row.get(signal);
    return v == null ? null : v;
  }

  private loadFlow(date: string): Map<string, number> {
    const cached = this.flow.get(date);
    if (cached) return cached;

    const rows = this.db
      .prepare(`
        SELECT date, fii_net AS fiiNet, dii_net AS diiNet
        FROM fii_dii
        WHERE date <= ? AND segment = 'cash'
        ORDER BY date DESC LIMIT 30
      `)
      .all(date) as Array<{ date: string; fiiNet: number; diiNet: number }>;

    const map = new Map<string, number>();
    if (rows.length > 0) {
      const today = rows[0];
      if (today) {
        map.set('fii_net', today.fiiNet);
        map.set('dii_net', today.diiNet);
      }
      const last5 = rows.slice(0, 5);
      map.set(
        'fii_net_5d_sum',
        last5.reduce((s, r) => s + r.fiiNet, 0),
      );
      map.set(
        'dii_net_5d_sum',
        last5.reduce((s, r) => s + r.diiNet, 0),
      );
      map.set('fii_net_streak_days', streak(rows.map((r) => r.fiiNet)));
      map.set('dii_net_streak_days', streak(rows.map((r) => r.diiNet)));
    }
    this.flow.set(date, map);
    return map;
  }
}

/**
 * Count of consecutive positive values from the start of the array.
 * Used to compute "FII has been net buyer for N consecutive sessions".
 */
function streak(values: number[]): number {
  let n = 0;
  for (const v of values) {
    if (v > 0) n++;
    else break;
  }
  return n;
}

/**
 * Test-only helper — wraps a plain map of (signal -> value) so tests can
 * exercise the evaluator without a DB.
 */
export class StaticSignalProvider implements SignalProvider {
  constructor(private readonly values: Record<string, number | null | undefined>) {}
  get(_symbol: string, _date: string, signal: string): number | null {
    const v = this.values[signal];
    return v == null ? null : v;
  }
}
