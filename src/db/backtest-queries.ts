/**
 * Persistence helpers for Option A walk-forward backtests (`backtest_runs` / `backtest_trades`).
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from './connection.js';

export interface OptionABacktestRunInsert {
  strategyId: string;
  screenName: string;
  startDate: string;
  endDate: string;
  holdDays: number;
  symbolsCount: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  hitRate: number;
  avgReturnPct: number;
  medianReturnPct: number;
  maxReturnPct: number;
  minReturnPct: number;
  maxDrawdownPct: number;
  expectancy: number;
  avgHoldDays: number;
  profitFactor: number;
  universeJson: string;
  costBpsRoundTrip: number;
  notes: string | null;
}

export interface OptionABacktestTradeInsert {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  returnPct: number;
  maxDrawdownPct: number;
  holdDays: number;
}

/** Distinct quote dates for NSE benchmark in [from, to] (sorted ASC). */
export function listBenchmarkTradingDates(
  benchSymbol: string,
  from: string,
  to: string,
  db: DatabaseType = getDb(),
): string[] {
  const rows = db
    .prepare(
      `
      SELECT DISTINCT date FROM quotes
      WHERE symbol = ? AND exchange = 'NSE' AND date >= ? AND date <= ?
      ORDER BY date ASC
    `,
    )
    .all(benchSymbol.toUpperCase(), from, to) as Array<{ date: string }>;
  return rows.map((r) => r.date);
}

export function regimeCoverageForWindow(
  tradingDates: string[],
  db: DatabaseType = getDb(),
): {
  totalDays: number;
  withRegime: number;
  ratio: number;
  regimeMin: string | null;
  regimeMax: string | null;
  regimeCount: number;
} {
  const meta = db
    .prepare('SELECT MIN(date) AS mn, MAX(date) AS mx, COUNT(*) AS c FROM regime_daily')
    .get() as { mn: string | null; mx: string | null; c: number };
  if (tradingDates.length === 0) {
    return {
      totalDays: 0,
      withRegime: 0,
      ratio: 1,
      regimeMin: meta.mn,
      regimeMax: meta.mx,
      regimeCount: meta.c,
    };
  }
  const ph = tradingDates.map(() => '?').join(',');
  const withRows = db
    .prepare(`SELECT COUNT(DISTINCT date) AS n FROM regime_daily WHERE date IN (${ph})`)
    .all(...tradingDates) as Array<{ n: number }>;
  const withRegime = withRows[0]?.n ?? 0;
  const ratio = withRegime / tradingDates.length;
  return {
    totalDays: tradingDates.length,
    withRegime,
    ratio,
    regimeMin: meta.mn,
    regimeMax: meta.mx,
    regimeCount: meta.c,
  };
}

/** Persisted `regime` label counts for dates in `tradingDates` (must match backtest window days). */
export function regimeHistogramForTradingDates(
  tradingDates: string[],
  db: DatabaseType = getDb(),
): Record<string, number> {
  if (tradingDates.length === 0) return {};
  const ph = tradingDates.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT regime, COUNT(*) AS n FROM regime_daily WHERE date IN (${ph}) GROUP BY regime`)
    .all(...tradingDates) as Array<{ regime: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.regime] = r.n;
  return out;
}

export function insertOptionABacktestRun(
  row: OptionABacktestRunInsert,
  db: DatabaseType = getDb(),
): number {
  const info = db
    .prepare(
      `
      INSERT INTO backtest_runs (
        screen_name, strategy_id, start_date, end_date, hold_days, symbols_count,
        total_trades, winning_trades, losing_trades, hit_rate,
        avg_return_pct, median_return_pct, max_return_pct, min_return_pct,
        max_drawdown_pct, expectancy, avg_hold_days, profit_factor,
        universe_json, cost_bps_round_trip, notes
      ) VALUES (
        @screenName, @strategyId, @startDate, @endDate, @holdDays, @symbolsCount,
        @totalTrades, @winningTrades, @losingTrades, @hitRate,
        @avgReturnPct, @medianReturnPct, @maxReturnPct, @minReturnPct,
        @maxDrawdownPct, @expectancy, @avgHoldDays, @profitFactor,
        @universeJson, @costBpsRoundTrip, @notes
      )
    `,
    )
    .run({
      screenName: row.screenName,
      strategyId: row.strategyId,
      startDate: row.startDate,
      endDate: row.endDate,
      holdDays: row.holdDays,
      symbolsCount: row.symbolsCount,
      totalTrades: row.totalTrades,
      winningTrades: row.winningTrades,
      losingTrades: row.losingTrades,
      hitRate: row.hitRate,
      avgReturnPct: row.avgReturnPct,
      medianReturnPct: row.medianReturnPct,
      maxReturnPct: row.maxReturnPct,
      minReturnPct: row.minReturnPct,
      maxDrawdownPct: row.maxDrawdownPct,
      expectancy: row.expectancy,
      avgHoldDays: row.avgHoldDays,
      profitFactor: row.profitFactor,
      universeJson: row.universeJson,
      costBpsRoundTrip: row.costBpsRoundTrip,
      notes: row.notes,
    });
  return Number(info.lastInsertRowid);
}

export function insertOptionABacktestTrades(
  runId: number,
  trades: OptionABacktestTradeInsert[],
  db: DatabaseType = getDb(),
): void {
  if (trades.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO backtest_trades (
      run_id, symbol, entry_date, entry_price, exit_date, exit_price,
      return_pct, max_drawdown_pct, hold_days
    ) VALUES (
      @runId, @symbol, @entryDate, @entryPrice, @exitDate, @exitPrice,
      @returnPct, @maxDrawdownPct, @holdDays
    )
  `);
  const tx = db.transaction((batch: OptionABacktestTradeInsert[]) => {
    for (const t of batch) {
      stmt.run({
        runId,
        symbol: t.symbol,
        entryDate: t.entryDate,
        entryPrice: t.entryPrice,
        exitDate: t.exitDate,
        exitPrice: t.exitPrice,
        returnPct: t.returnPct,
        maxDrawdownPct: t.maxDrawdownPct,
        holdDays: t.holdDays,
      });
    }
  });
  tx(trades);
}
