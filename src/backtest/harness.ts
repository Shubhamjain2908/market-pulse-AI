/**
 * Backtest harness. Replays a screen against historical data: for every
 * trading session in [startDate, endDate], evaluate the screen for each
 * watchlist symbol, treat each match as a hypothetical "buy at next-day
 * open" → "sell after holdDays sessions" trade, and aggregate the
 * realised returns + drawdowns.
 *
 * Implementation notes:
 *   - We use the SAME ScreenEngine + SignalProvider that the live agent
 *     uses, so backtest matches what'd actually fire today. The provider
 *     correctly handles as-of-date queries (`signals.date <= ?` with a
 *     window function).
 *   - "Trading sessions" are derived from the `quotes` table, not a
 *     calendar — this naturally handles weekends, holidays, and gaps.
 *   - One backtest run produces one row in `backtest_runs` and N rows in
 *     `backtest_trades`. Multiple symbols can match the same screen on
 *     the same date — each becomes a separate trade.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { runScreenEngine } from '../analysers/engine.js';
import { DbSignalProvider } from '../analysers/signal-provider.js';
import { loadScreens, loadWatchlist } from '../config/loaders.js';
import { getDb } from '../db/index.js';
import { child } from '../logger.js';
import type { ScreenDefinition } from '../types/domain.js';
import { type AggregateMetrics, type Bar, type Trade, aggregate, buildTrade } from './metrics.js';

const log = child({ component: 'backtest-harness' });

export interface BacktestOptions {
  /** Inclusive start of the replay window (YYYY-MM-DD). */
  startDate: string;
  /** Inclusive end of the replay window. */
  endDate: string;
  /** Number of trading sessions to hold each match. Default 10 (~2 weeks). */
  holdDays?: number;
  /** Restrict to a single screen by name; otherwise runs all configured. */
  screenName?: string;
  /** Override the watchlist universe. */
  symbols?: string[];
  /** Override the screens loaded from config (mostly for tests/backtests of in-flight ideas). */
  screens?: ScreenDefinition[];
}

export interface ScreenBacktestResult {
  screenName: string;
  startDate: string;
  endDate: string;
  holdDays: number;
  symbolsCount: number;
  metrics: AggregateMetrics;
  trades: Trade[];
}

export interface BacktestRun extends ScreenBacktestResult {
  runId: number;
}

export interface BacktestSummary {
  results: BacktestRun[];
  totalRuns: number;
}

export function runBacktest(opts: BacktestOptions, db: DatabaseType = getDb()): BacktestSummary {
  const holdDays = opts.holdDays ?? 10;
  const symbols = (opts.symbols ?? loadWatchlist().symbols).map((s) => s.toUpperCase());
  const allScreens = opts.screens ?? loadScreens();
  const screens = opts.screenName
    ? allScreens.filter((s) => s.name === opts.screenName)
    : allScreens;
  if (screens.length === 0) {
    throw new Error(`No screens to backtest (requested: ${opts.screenName ?? 'all'})`);
  }

  const tradingDates = listTradingDates(opts.startDate, opts.endDate, db);
  if (tradingDates.length === 0) {
    log.warn(
      { start: opts.startDate, end: opts.endDate },
      'no trading sessions in window — has the quotes table been populated?',
    );
    return { results: [], totalRuns: 0 };
  }

  // Pre-load the closing-price series once per symbol so each screen pass
  // can build trades quickly.
  const barsBySymbol = loadBars(symbols, opts.startDate, db);

  const provider = new DbSignalProvider(db);
  const results: BacktestRun[] = [];

  for (const screen of screens) {
    const trades: Trade[] = [];
    log.info(
      { screen: screen.name, dates: tradingDates.length, symbols: symbols.length },
      'backtesting screen',
    );

    for (const date of tradingDates) {
      const evalResult = runScreenEngine(
        { date, symbols, screens: [screen], provider, persist: false },
        db,
      );
      const matched = evalResult.evaluations.filter((e) => e.passed);
      for (const m of matched) {
        const trade = makeTrade(m.symbol, date, holdDays, barsBySymbol);
        if (trade) trades.push(trade);
      }
    }

    const metrics = aggregate(trades);
    const runId = persistRun(screen, opts, holdDays, symbols.length, metrics, trades, db);
    results.push({
      runId,
      screenName: screen.name,
      startDate: opts.startDate,
      endDate: opts.endDate,
      holdDays,
      symbolsCount: symbols.length,
      metrics,
      trades,
    });
    log.info(
      {
        screen: screen.name,
        trades: metrics.totalTrades,
        hitRate: metrics.hitRate.toFixed(3),
        avgReturn: metrics.avgReturnPct.toFixed(2),
        runId,
      },
      'backtest run complete',
    );
  }

  return { results, totalRuns: results.length };
}

function listTradingDates(start: string, end: string, db: DatabaseType): string[] {
  const rows = db
    .prepare(`
      SELECT DISTINCT date FROM quotes
      WHERE date >= ? AND date <= ?
      ORDER BY date ASC
    `)
    .all(start, end) as Array<{ date: string }>;
  return rows.map((r) => r.date);
}

function loadBars(symbols: string[], fromDate: string, db: DatabaseType): Map<string, Bar[]> {
  const map = new Map<string, Bar[]>();
  if (symbols.length === 0) return map;
  const placeholders = symbols.map(() => '?').join(',');
  const rows = db
    .prepare(`
      SELECT symbol, date, close FROM quotes
      WHERE symbol IN (${placeholders}) AND date >= ?
      ORDER BY symbol, date ASC
    `)
    .all(...symbols, fromDate) as Array<{ symbol: string; date: string; close: number }>;
  for (const r of rows) {
    const list = map.get(r.symbol) ?? [];
    list.push({ date: r.date, close: r.close });
    map.set(r.symbol, list);
  }
  return map;
}

function makeTrade(
  symbol: string,
  signalDate: string,
  holdDays: number,
  barsBySymbol: Map<string, Bar[]>,
): Trade | null {
  const bars = barsBySymbol.get(symbol);
  if (!bars || bars.length === 0) return null;
  // Entry: the first bar AFTER the signal date (next-day close stand-in;
  // we don't model intraday so close-to-close is fine for a v1 backtest).
  const entryIdx = bars.findIndex((b) => b.date > signalDate);
  if (entryIdx === -1) return null;
  const entry = bars[entryIdx];
  if (!entry) return null;
  const forward = bars.slice(entryIdx + 1);
  return buildTrade(symbol, entry, forward, holdDays);
}

function persistRun(
  screen: ScreenDefinition,
  opts: BacktestOptions,
  holdDays: number,
  symbolsCount: number,
  metrics: AggregateMetrics,
  trades: Trade[],
  db: DatabaseType,
): number {
  const insertRun = db.prepare(`
    INSERT INTO backtest_runs (
      screen_name, start_date, end_date, hold_days, symbols_count,
      total_trades, winning_trades, losing_trades, hit_rate,
      avg_return_pct, median_return_pct, max_return_pct, min_return_pct,
      max_drawdown_pct
    ) VALUES (
      @screen, @start, @end, @holdDays, @symbolsCount,
      @total, @winning, @losing, @hitRate,
      @avg, @median, @max, @min, @dd
    )
  `);
  const insertTrade = db.prepare(`
    INSERT INTO backtest_trades (
      run_id, symbol, entry_date, entry_price, exit_date, exit_price,
      return_pct, max_drawdown_pct, hold_days
    ) VALUES (
      @runId, @symbol, @entryDate, @entryPrice, @exitDate, @exitPrice,
      @returnPct, @drawdown, @holdDays
    )
  `);
  const tx = db.transaction(() => {
    const info = insertRun.run({
      screen: screen.name,
      start: opts.startDate,
      end: opts.endDate,
      holdDays,
      symbolsCount,
      total: metrics.totalTrades,
      winning: metrics.winningTrades,
      losing: metrics.losingTrades,
      hitRate: metrics.hitRate,
      avg: metrics.avgReturnPct,
      median: metrics.medianReturnPct,
      max: metrics.maxReturnPct,
      min: metrics.minReturnPct,
      dd: metrics.maxDrawdownPct,
    });
    const runId = Number(info.lastInsertRowid);
    for (const t of trades) {
      insertTrade.run({
        runId,
        symbol: t.symbol,
        entryDate: t.entryDate,
        entryPrice: t.entryPrice,
        exitDate: t.exitDate,
        exitPrice: t.exitPrice,
        returnPct: t.returnPct,
        drawdown: t.maxDrawdownPct,
        holdDays: t.holdDays,
      });
    }
    return runId;
  });
  return tx();
}
