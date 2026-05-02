/**
 * Daily evaluation of open paper trades: SL / target / time-stop vs EOD quotes.
 * Conservative rule: if both SL and target are touched on the same day, count as LOSS.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { type PaperTradeRow, closePaperTrade, getOpenPaperTrades } from '../db/queries.js';
import { NIFTY_BENCHMARK_SYMBOL } from '../market/benchmarks.js';
export interface EvaluateTradesResult {
  asOf: string;
  evaluated: number;
  closed: number;
  closedWin: number;
  closedLoss: number;
  closedTime: number;
  stillOpen: number;
  skippedNoData: number;
}

interface OhlcBar {
  date: string;
  high: number;
  low: number;
  close: number;
}

export function buildTradingDayIndex(
  db: DatabaseType,
  sourceDate: string,
  asOf: string,
): Map<string, number> {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT date FROM quotes
    WHERE symbol = ? AND exchange = 'NSE' AND date > ? AND date <= ?
    ORDER BY date ASC
  `,
    )
    .all(NIFTY_BENCHMARK_SYMBOL, sourceDate, asOf) as Array<{ date: string }>;
  const m = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row) m.set(row.date, i + 1);
  }
  return m;
}

function getSymbolBars(
  db: DatabaseType,
  symbol: string,
  sourceDate: string,
  asOf: string,
): OhlcBar[] {
  return db
    .prepare(
      `
    SELECT date, high, low, close FROM quotes
    WHERE symbol = ? AND exchange = 'NSE' AND date > ? AND date <= ?
    ORDER BY date ASC
  `,
    )
    .all(symbol, sourceDate, asOf) as OhlcBar[];
}

function pnlPctLong(entry: number, exit: number): number {
  return ((exit - entry) / entry) * 100;
}

export function evaluateOnePaperTrade(
  trade: PaperTradeRow,
  db: DatabaseType,
  asOf: string,
): 'CLOSED_WIN' | 'CLOSED_LOSS' | 'CLOSED_TIME' | 'no_data' | 'still_open' {
  const bars = getSymbolBars(db, trade.symbol, trade.sourceDate, asOf);
  if (bars.length === 0) return 'no_data';

  const dayIndex = buildTradingDayIndex(db, trade.sourceDate, asOf);

  for (const bar of bars) {
    const hitSl = bar.low <= trade.stopLoss;
    const hitTg = bar.high >= trade.target;
    const elapsed = dayIndex.get(bar.date) ?? 0;

    if (hitSl && hitTg) {
      const pnl = pnlPctLong(trade.entryPrice, trade.stopLoss);
      closePaperTrade(
        trade.id,
        'CLOSED_LOSS',
        bar.date,
        trade.stopLoss,
        pnl,
        db,
        'same-day SL+TP: counted as loss (conservative)',
      );
      return 'CLOSED_LOSS';
    }
    if (hitSl) {
      const pnl = pnlPctLong(trade.entryPrice, trade.stopLoss);
      closePaperTrade(trade.id, 'CLOSED_LOSS', bar.date, trade.stopLoss, pnl, db);
      return 'CLOSED_LOSS';
    }
    if (hitTg) {
      const pnl = pnlPctLong(trade.entryPrice, trade.target);
      closePaperTrade(trade.id, 'CLOSED_WIN', bar.date, trade.target, pnl, db);
      return 'CLOSED_WIN';
    }
    if (elapsed >= trade.maxHoldDays) {
      const pnl = pnlPctLong(trade.entryPrice, bar.close);
      closePaperTrade(trade.id, 'CLOSED_TIME', bar.date, bar.close, pnl, db);
      return 'CLOSED_TIME';
    }
  }

  return 'still_open';
}

export function runEvaluatePaperTrades(asOf: string, db: DatabaseType): EvaluateTradesResult {
  const open = getOpenPaperTrades(db);
  let closedWin = 0;
  let closedLoss = 0;
  let closedTime = 0;
  let skippedNoData = 0;

  for (const t of open) {
    const result = evaluateOnePaperTrade(t, db, asOf);
    if (result === 'no_data') {
      skippedNoData++;
    } else if (result === 'CLOSED_WIN') closedWin++;
    else if (result === 'CLOSED_LOSS') closedLoss++;
    else if (result === 'CLOSED_TIME') closedTime++;
  }

  const closed = closedWin + closedLoss + closedTime;
  const stillOpen = getOpenPaperTrades(db).length;

  return {
    asOf,
    evaluated: open.length,
    closed,
    closedWin,
    closedLoss,
    closedTime,
    stillOpen,
    skippedNoData,
  };
}
